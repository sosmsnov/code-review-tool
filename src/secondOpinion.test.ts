import './testEnv.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'crt-second-opinion-'));
process.env.DATA_DIR = path.join(root, 'data');

const { buildBackground, buildRuleFile, MAX_BACKGROUND_CHARS, RULE_INCLUDE } = await import('./secondOpinion/files.js');
const { buildOcrArgs, createOcrProvider, forwardOcrLine, parseElapsed, parseOcrOutput } = await import('./secondOpinion/ocr.js');
const {
  conclusionOutputSchema, mergeAssessments, MAX_ASSESSED_COMMENTS, parseFindingNumber, renderPrimaryFindings, renderSecondOpinionComments, sortComments,
} = await import('./secondOpinion/conclusion.js');
const { countsLine, formatElapsed, formatTokens } = await import('./secondOpinion/format.js');
const { providerTimeoutMinutes } = await import('./secondOpinion/run.js');
const { closeOpenState, parseSecondOpinionState, pendingState, summarizeSecondOpinion } = await import('./secondOpinion/state.js');
const { resolveSecondOpinion, setSecondOpinionProviderForTests } = await import('./secondOpinion/index.js');
const { liveReviewerGroups, normalize, runPass, ReviewGroupTracker } = await import('./reviewRunner.js');
import type { ReviewerDefinition } from './reviewers/types.js';
import type { SecondOpinionComment, SecondOpinionProvider } from './secondOpinion/types.js';
import type { Finding, ReviewOutput } from './types.js';

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
const sample = fs.readFileSync(path.join(FIXTURES, 'ocr-review-output.json'), 'utf8');

test.after(() => {
  for (const pgid of liveReviewerGroups()) {
    try { process.kill(-pgid, 'SIGKILL'); } catch { /* gone */ }
  }
  fs.rmSync(root, { recursive: true, force: true });
});

// --- background and rule files -------------------------------------------------

test('the background puts the ticket, checklist, decisions and scope first, and trims the ticket text to the cap', () => {
  const input = {
    ticketKey: 'ABC-1',
    ticketTitle: 'Order totals',
    ticketBody: 'Totals must include the discount once.',
    comments: [{ author: 'pm', body: 'Rounding stays as it is.' }],
    checklist: [{ id: 1, text: 'Apply the discount once' }, { id: 2, text: 'Keep  rounding' }],
    requirementsText: 'Decision: no new endpoint.',
    ticketScope: '## How this ticket is split\n\nOne slice.',
  };
  const text = buildBackground(input);
  const order = ['# ABC-1: Order totals', '- R1 Apply the discount once', '- R2 Keep rounding', 'Decision: no new endpoint.',
    '## How this ticket is split', '## Ticket', 'Totals must include the discount once.', '- pm: Rounding stays as it is.'];
  let at = -1;
  for (const part of order) {
    const next = text.indexOf(part);
    assert.ok(next > at, `${part} comes after the previous part`);
    at = next;
  }

  const long = buildBackground({ ...input, ticketBody: 'x'.repeat(20_000) });
  assert.ok(long.length <= MAX_BACKGROUND_CHARS, `${long.length} <= cap`);
  assert.match(long, /- R2 Keep rounding/);
  assert.match(long, /Decision: no new endpoint\./);
  assert.match(long, /One slice\./);
  assert.match(long, /\(trimmed\)$/);

  const noTicket = buildBackground({ ticketKey: null, ticketTitle: null, ticketBody: null });
  assert.equal(noTicket, '# Change under review');
  const hugeHead = buildBackground({ ...input, requirementsText: 'y'.repeat(9_000) });
  assert.ok(hugeHead.length <= MAX_BACKGROUND_CHARS);
  assert.doesNotMatch(hugeHead, /## Ticket/, 'the ticket text goes first');
});

test('the rule file carries the repository rules for every path and always includes the tests', () => {
  const withRules = JSON.parse(buildRuleFile('  Use the service layer.  '));
  assert.deepEqual(withRules, {
    rules: [{ path: '**/*', rule: 'Use the service layer.', merge_system_rule: true }],
    include: [...RULE_INCLUDE],
  });
  assert.deepEqual(JSON.parse(buildRuleFile('')), { include: [...RULE_INCLUDE] });
});

// --- the ocr provider ------------------------------------------------------------

test('ocr is called on the exact range with the files, the limits, and no provider or model', () => {
  const args = buildOcrArgs({
    dir: '/w/checkout', baseSha: 'b'.repeat(40), headSha: 'h'.repeat(40), backgroundFile: '/d/bg.md', ruleFile: '/d/rule.json',
    outputFile: '/d/out.json', concurrency: 3, timeoutMinutes: 15, tokenBudget: 800_000,
  });
  assert.deepEqual(args, [
    'review', '--repo', '/w/checkout', '--from', 'b'.repeat(40), '--to', 'h'.repeat(40), '--format', 'json',
    '--output', '/d/out.json', '--audience', 'human', '--color', 'never', '--concurrency', '3', '--timeout', '15',
    '--max-tokens-budget', '800000', '--rule', '/d/rule.json', '--background-file', '/d/bg.md',
  ]);
  assert.ok(!args.includes('--provider') && !args.includes('--model'));
  const env = createOcrProvider('/bin/true').buildChildEnv();
  assert.equal(env.REVIEW_GH_TOKEN, undefined);
  assert.equal(env.GITHUB_TOKEN, undefined);
});

test('ocr output parses into comments, tokens, files and time', () => {
  const result = parseOcrOutput(sample);
  assert.equal(result.comments.length, 3);
  assert.deepEqual(result.comments[0], {
    path: 'src/orders/service.ts', start_line: 42, end_line: 44, severity: 'medium', category: 'bug',
    content: 'The discount is applied twice when the order already has a coupon.',
    existing_code: 'total = applyDiscount(applyDiscount(total, coupon), coupon);',
  });
  assert.equal(result.comments[1]!.suggestion_code?.startsWith('it('), true);
  assert.equal(result.files_reviewed, 4);
  assert.deepEqual(result.tokens, { total: 244534, input: 231465, output: 13069 });
  assert.equal(result.elapsed_ms, 191537);
  assert.equal(result.model, 'example-model');
  assert.equal(result.partial, false);
  assert.equal(result.provider_status, 'complete');
});

test('ocr output is parsed leniently', () => {
  const result = parseOcrOutput(JSON.stringify({
    summary: { elapsed: '1m5s' },
    comments: [
      { path: 'a.ts', content: 'No lines.', severity: 'Critical', category: 'Security' },
      { path: 'b.ts', content: 'Odd lines.', start_line: '7', end_line: 2 },
      { path: 'c.ts', content: '   ' },
      'not a comment',
    ],
    manifest: { coverage: { failed: [{ item_id: 'x' }] } },
  }));
  assert.deepEqual(result.comments.map((c) => [c.path, c.start_line, c.end_line, c.severity, c.category]), [
    ['a.ts', 1, 1, 'critical', 'security'],
    ['b.ts', 7, 7, 'unknown', 'other'],
  ]);
  assert.equal(result.elapsed_ms, 65_000);
  assert.equal(result.tokens, undefined);
  assert.equal(result.partial, true);
  assert.deepEqual(parseOcrOutput('{}').comments, []);
  assert.equal(parseOcrOutput(JSON.stringify({ status: 'budget_exhausted', comments: [] })).partial, true);
  assert.throws(() => parseOcrOutput('not json'), /not valid JSON/);
  assert.throws(() => parseOcrOutput('[]'), /not a JSON object/);
  assert.equal(parseElapsed('3m12s'), 192_000);
  assert.equal(parseElapsed('soon'), undefined);
  assert.equal(parseElapsed('1.2.3s'), undefined);
});

test('ocr progress is forwarded without the per-tool-call lines', () => {
  const lines = fs.readFileSync(path.join(FIXTURES, 'ocr-review-stderr.txt'), 'utf8').split('\n');
  const forwarded = lines.map(forwardOcrLine).filter((l): l is string => l !== null);
  assert.ok(forwarded.includes('4 file(s) changed, reviewing 4 in /tmp/checkout'));
  assert.ok(forwarded.includes('Review complete: 3 finding(s) across 4 selected item(s).'));
  assert.ok(forwarded.every((l) => !/^[▶✔]/.test(l) && !l.startsWith('[ocr]')));
  assert.equal(forwarded.length, lines.filter((l) => l.trim() && !/[▶✔]/.test(l)).length);
});

test('a failed ocr run is described with its exit code, an authentication failure as such', () => {
  const ocr = createOcrProvider('ocr');
  assert.equal(ocr.describeFailure('boom', 2), 'ocr exited with code 2');
  assert.match(ocr.describeFailure('error: 401 Unauthorized', 1), /could not authenticate/);
});

// --- choosing it ---------------------------------------------------------------

function fakeProvider(available: boolean): SecondOpinionProvider {
  return { ...createOcrProvider('/nonexistent/ocr'), isAvailable: () => available };
}

test('an explicit provider must be installed; none and the inherited choice are kept; the default is none', () => {
  setSecondOpinionProviderForTests('ocr', fakeProvider(false));
  try {
    assert.throws(() => resolveSecondOpinion('ocr'), /Open Code Review is not installed: \/nonexistent\/ocr not found on PATH/);
    assert.equal(resolveSecondOpinion('none'), null);
    assert.equal(resolveSecondOpinion(undefined), null);
    assert.equal(resolveSecondOpinion(undefined, 'ocr'), 'ocr');
    assert.equal(resolveSecondOpinion(undefined, null), null);
    setSecondOpinionProviderForTests('ocr', fakeProvider(true));
    assert.equal(resolveSecondOpinion('ocr'), 'ocr');
    assert.equal(resolveSecondOpinion('none', 'ocr'), null);
  } finally {
    setSecondOpinionProviderForTests('ocr', null);
  }
});

test('the stored state round-trips, summarises, and is closed when its review ends first', () => {
  const pending = pendingState('ocr', '2026-01-01T00:00:00.000Z');
  assert.deepEqual(parseSecondOpinionState(JSON.stringify(pending)), pending);
  assert.equal(parseSecondOpinionState('not json'), null);
  assert.equal(parseSecondOpinionState(JSON.stringify({ provider: 'other' })), null);
  assert.deepEqual(summarizeSecondOpinion(pending), {
    provider: 'ocr', status: 'pending', comments_total: 0,
    counts: { confirmed: 0, duplicate: 0, observation: 0, rejected: 0, not_assessed: 0 },
    primary_verdict: null, elapsed_ms: null, tokens_total: null, error: null,
  });
  assert.equal(closeOpenState(pending, 'cancelled')!.status, 'skipped');
  assert.equal(closeOpenState({ ...pending, status: 'running' }, 'cancelled')!.status, 'failed');
  assert.equal(closeOpenState({ ...pending, status: 'done' }, 'cancelled'), null);
  assert.equal(formatTokens(244_534), '245k');
  assert.equal(formatTokens(950), '950');
  assert.equal(formatElapsed(191_537), '3m12s');
  assert.equal(providerTimeoutMinutes(900_000), 14);
  assert.equal(providerTimeoutMinutes(1_500), 1);
});

// --- the conclusion pass ------------------------------------------------------------

function finding(overrides: Partial<Finding> = {}): Finding {
  return {
    severity: 'minor', category: 'correctness', file: 'src/orders/service.ts', line: 5, end_line: null, title: 'Primary finding',
    problem: 'A problem.', why: '', suggestion: '', snippet: null, kind: 'diff', cause_file: null, cause_line: null, hunk: null,
    lens: 'correctness', anchor_status: 'ok', ...overrides,
  };
}

function comment(i: number, severity = 'medium'): SecondOpinionComment {
  return { path: `src/orders/f${i}.ts`, start_line: i, end_line: i, severity, category: 'bug', content: `Comment ${i}.` };
}

const confirmedFinding = {
  severity: 'major', category: 'correctness', kind: 'diff', file: 'src/orders/service.ts', line: 42, end_line: 44,
  title: 'Discount applied twice', problem: 'The coupon discount is applied twice.', why: 'Customers pay too little.',
  suggestion: 'Apply it once.', snippet: null,
};

test('comments are sorted by the provider severity, rendered by number, and the primary result by number', () => {
  const sorted = sortComments([comment(1, 'low'), comment(2, 'high'), comment(3, 'odd'), comment(4, 'medium'), comment(5, 'high')]);
  assert.deepEqual(sorted.map((c) => c.start_line), [2, 5, 4, 1, 3]);
  const rendered = renderSecondOpinionComments([{ ...comment(1), existing_code: 'a ``` b', suggestion_code: 'c' }]);
  assert.match(rendered, /^## Comment 1: src\/orders\/f1\.ts:1 \(tool severity medium, category bug\)/);
  assert.match(rendered, /Existing code:\n```\na ''' b\n```/);
  const primary = renderPrimaryFindings({
    findings: [finding(), finding({ kind: 'regression', file: 'src/a.ts', cause_file: 'src/b.ts', cause_line: 3, severity: 'major' })],
    observations: [{ file: null, line: null, note: 'A note.', rationale: '' }],
  });
  assert.match(primary, /^1\. \[minor\] src\/orders\/service\.ts:5: Primary finding\. A problem\.$/m);
  assert.match(primary, /^2\. \[major, regression, caused by src\/b\.ts:3\] src\/a\.ts:5/m);
  assert.match(primary, /^O1\. no location: A note\.$/m);
  assert.match(renderPrimaryFindings({ findings: [], observations: [] }), /## Findings\n\nNone\./);
});

test('the conclusion answer is lenient on spelling and strict on what the merge needs', () => {
  const schema = conclusionOutputSchema(2);
  const ok = schema.safeParse({
    assessments: [
      { comment: '1', verdict: 'Confirm', reason: 'Real.', finding: confirmedFinding },
      { comment: 2, verdict: 'duplicated', duplicate_of: 'F2', reason: null },
      { comment: 3, verdict: 'observation' },
      { comment: 4, verdict: 'reject' },
    ],
  });
  assert.ok(ok.success, JSON.stringify(ok.error?.issues));
  assert.deepEqual(ok.data.assessments.map((a) => [a.comment, a.verdict, a.duplicate_of]), [
    [1, 'confirmed', null], [2, 'duplicate', 2], [3, 'observation', null], [4, 'rejected', null],
  ]);
  assert.equal(ok.data.conclusion, '');
  assert.equal(ok.data.assessments[0]!.finding!.kind, 'diff');

  for (const bad of [
    { comment: 1, verdict: 'confirmed', reason: 'x' },
    { comment: 1, verdict: 'duplicate', duplicate_of: 3 },
    { comment: 1, verdict: 'duplicate', duplicate_of: '#1, #4' },
    { comment: 1, verdict: 'duplicate', duplicate_of: 1.5 },
    { comment: 1, verdict: 'duplicate', duplicate_of: '1.5' },
    { comment: 1, verdict: 'maybe' },
  ]) {
    assert.equal(schema.safeParse({ assessments: [bad] }).success, false, JSON.stringify(bad));
  }
});

test('a finding number is one integer, optionally after # or F; anything else is none', () => {
  for (const [value, expected] of [
    [2, 2], ['2', 2], [' #2 ', 2], ['F2', 2], ['f12', 12], ['# 3', 3],
    ['#1, #4', null], ['1.5', null], [1.5, null], [0, null], ['-1', null], ['R2', null], ['two', null], ['', null],
    [null, null], [undefined, null], [[2], null],
  ] as const) {
    assert.equal(parseFindingNumber(value), expected, JSON.stringify(value));
  }
});

test('garbage from the conclusion pass gets one corrective retry', async () => {
  const counter = path.join(root, 'conclusion-count');
  const answer = JSON.stringify({ assessments: [{ comment: 1, verdict: 'rejected', reason: 'Not real.' }], conclusion: 'Nothing new.' });
  const script = `
n=$(cat "${counter}" 2>/dev/null || echo 0); n=$((n+1)); echo $n > "${counter}"
if [ $n -eq 1 ]; then echo 'I think it is fine.'; else printf '%s\\n' '${answer}'; fi
`;
  const reviewer: ReviewerDefinition = {
    name: 'claude', label: 'Fake reviewer', defaultModel: 'fake', defaultModelEnv: 'REVIEW_MODEL', bin: '/bin/sh',
    buildArgs: () => ['-c', script], buildChildEnv: () => ({ PATH: process.env.PATH }),
    parseStreamLine: (line) => ({ result: line }),
    discoverModels: async () => ({ models: [], source: null, fetchedAt: Date.now(), hint: null }),
    isAvailable: () => true, describeFailure: () => null,
  };
  const logs: string[] = [];
  const { data } = await runPass('conclusion', 'prompt', conclusionOutputSchema(0), (_l, m) => logs.push(m), {
    dir: root, reviewer, model: 'fake', timeoutMs: 30_000, signal: undefined, groups: new ReviewGroupTracker(),
  });
  assert.equal(fs.readFileSync(counter, 'utf8').trim(), '2');
  assert.equal(data.conclusion, 'Nothing new.');
  assert.ok(logs.some((l) => /conclusion: output was not valid JSON\. Retrying once\./.test(l)));
});

test('the merge adds confirmed findings and observations, marks duplicates, keeps rejections, and leaves the rest unassessed', () => {
  const comments = Array.from({ length: MAX_ASSESSED_COMMENTS + 2 }, (_, i) => comment(i + 1));
  const answer = conclusionOutputSchema(2).parse({
    assessments: [
      { comment: 1, verdict: 'confirmed', reason: 'Reproduced.', finding: confirmedFinding },
      { comment: 2, verdict: 'duplicate', duplicate_of: 2, reason: 'Same as finding 2.' },
      { comment: 3, verdict: 'observation', reason: 'Simpler with a map.', observation: { file: 'src/x.ts', line: 3, note: 'Use a map.' } },
      { comment: 4, verdict: 'observation', reason: 'Fine, but naming.' },
      { comment: 5, verdict: 'rejected', reason: 'The code handles it on line 9.' },
      { comment: 5, verdict: 'confirmed', reason: 'twice', finding: confirmedFinding },
      { comment: 99, verdict: 'rejected', reason: 'not sent' },
    ],
    conclusion: 'One new defect.',
  });
  const logs: string[] = [];
  const merged = mergeAssessments(comments, MAX_ASSESSED_COMMENTS, answer, 2, (_l, m) => logs.push(m));

  assert.equal(merged.findings.length, 1);
  assert.equal(merged.findings[0]!.lens, 'second_opinion');
  assert.equal(merged.findings[0]!.severity, 'major');
  assert.deepEqual(merged.comments[0]!.assessment, { verdict: 'confirmed', reason: 'Reproduced.', duplicate_of: null, finding_ord: 2 });
  assert.deepEqual(merged.corroborated, [1]);
  assert.deepEqual(merged.comments[1]!.assessment, { verdict: 'duplicate', reason: 'Same as finding 2.', duplicate_of: 2, finding_ord: 1 });
  assert.deepEqual(merged.observations, [
    { file: 'src/x.ts', line: 3, note: 'Use a map.', rationale: '', lens: 'second_opinion' },
    { file: 'src/orders/f4.ts', line: 4, note: 'Fine, but naming.', rationale: '', lens: 'second_opinion' },
  ]);
  assert.deepEqual(merged.comments[4]!.assessment, {
    verdict: 'rejected', reason: 'The code handles it on line 9.', duplicate_of: null, finding_ord: null,
  });
  assert.equal(merged.comments[5]!.assessment!.verdict, 'not_assessed');
  assert.match(merged.comments[MAX_ASSESSED_COMMENTS]!.assessment!.reason, new RegExp(`only the first ${MAX_ASSESSED_COMMENTS} comments`));
  assert.deepEqual(merged.counts, {
    confirmed: 1, duplicate: 1, observation: 2, rejected: 1, not_assessed: MAX_ASSESSED_COMMENTS + 2 - 5,
  });
  assert.equal(countsLine(merged.counts), `1 confirmed, 1 duplicate, 2 observations, 1 rejected, ${MAX_ASSESSED_COMMENTS - 3} not assessed`);
  assert.ok(logs.some((l) => /comment 5 was assessed twice/.test(l)));
  assert.ok(logs.some((l) => /comment 99, which was not sent/.test(l)));
});

test('a confirmed major turns an approve into changes requested; the second opinion never turns one into approve', () => {
  const base: ReviewOutput = {
    summary: 's', requirements: [{ text: 'r', status: 'met', evidence: 'e' }], findings: [finding()], observations: [],
    verdict: 'approve', can_merge: true, conclusion: '',
  };
  const primary = normalize(base);
  assert.equal(primary.verdict, 'approve');
  const answer = conclusionOutputSchema(1).parse({
    assessments: [{ comment: 1, verdict: 'confirmed', reason: 'Real.', finding: confirmedFinding }],
  });
  const merged = mergeAssessments([comment(1)], 1, answer, 1);
  const after = normalize({ ...primary, findings: [...primary.findings, ...merged.findings] });
  assert.equal(after.verdict, 'changes_requested');
  assert.equal(after.can_merge, false);
  assert.equal(after.code_verdict, 'changes_requested');

  const blocked = normalize({ ...base, findings: [finding({ severity: 'major' })], verdict: 'changes_requested', can_merge: false });
  const minor = conclusionOutputSchema(1).parse({
    assessments: [{ comment: 1, verdict: 'confirmed', reason: 'Small.', finding: { ...confirmedFinding, severity: 'nit' } }],
  });
  const still = normalize({ ...blocked, findings: [...blocked.findings, ...mergeAssessments([comment(1)], 1, minor, 1).findings] });
  assert.equal(still.verdict, 'changes_requested');
  assert.equal(still.can_merge, false);
});
