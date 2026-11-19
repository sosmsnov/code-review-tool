import './testEnv.js';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

/**
 * runReview end to end with a second opinion: a stand-in reviewer CLI answers
 * the lenses, synthesis and the conclusion pass; a stand-in `ocr` (a shell
 * script) writes a fixed JSON to its --output path and progress to stderr.
 */
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'crt-so-pipeline-'));
process.env.DATA_DIR = path.join(root, 'data');

const { isGroupAlive } = await import('./processOwnership.js');
const { liveReviewerGroups, runReview } = await import('./reviewRunner.js');
const { createOcrProvider } = await import('./secondOpinion/ocr.js');
const { NOTHING_FOUND } = await import('./secondOpinion/conclusion.js');
import type { RecordedGroup } from './processOwnership.js';
import type { RunnableReview } from './reviewRunner.js';
import type { ReviewerDefinition } from './reviewers/types.js';
import type { SecondOpinionRequest } from './secondOpinion/run.js';
import type { SecondOpinionState } from './secondOpinion/types.js';
import type { CheckoutResult } from './types.js';

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
const repo = path.join(root, 'repo');
const prompts = path.join(root, 'prompts');
const bin = path.join(root, 'bin');
fs.mkdirSync(repo);
fs.mkdirSync(prompts);
fs.mkdirSync(bin);

function git(...args: string[]): string {
  return execFileSync('git', args, {
    cwd: repo,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid',
      GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid',
      GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
    },
  });
}
const lines = (n: number, tag: string) => Array.from({ length: n }, (_, i) => `${tag} ${i + 1}`).join('\n') + '\n';

git('init', '-q', '-b', 'main');
fs.mkdirSync(path.join(repo, 'src/orders'), { recursive: true });
fs.mkdirSync(path.join(repo, 'docs'));
fs.writeFileSync(path.join(repo, 'src/orders/service.ts'), lines(50, 'service'));
fs.writeFileSync(path.join(repo, 'docs/orders.md'), lines(10, 'doc'));
git('add', '-A');
git('commit', '-q', '-m', 'base');
const baseSha = git('rev-parse', 'HEAD').trim();
fs.writeFileSync(path.join(repo, 'src/orders/service.ts'), lines(60, 'service v2'));
git('commit', '-q', '-am', 'branch');
const headSha = git('rev-parse', 'HEAD').trim();

const checkout: CheckoutResult = {
  dir: repo, headSha, baseSha, filesChanged: 1, additions: 60, deletions: 50,
  changedFiles: ['src/orders/service.ts'],
  changedFileList: [{ path: 'src/orders/service.ts', status: 'M', old_path: null, additions: 60, deletions: 50 }],
};

const synthesis = {
  summary: 'Changes the order totals.',
  requirements: [{ text: 'Apply the discount', status: 'met', evidence: 'src/orders/service.ts:3' }],
  findings: [{ severity: 'minor', kind: 'diff', file: 'src/orders/service.ts', line: 5, lens: 'correctness', title: 'Primary finding', problem: 'p1' }],
  observations: [],
  verdict: 'approve',
  can_merge: true,
  conclusion: 'Fine.',
};

// The fixture comments, highest provider severity first: 1 docs (high), 2 discount (medium), 3 test (low).
const conclusion = {
  assessments: [
    { comment: 1, verdict: 'observation', reason: 'The doc is not part of the change.', observation: { file: 'docs/orders.md', line: 7, note: 'Worth a look later.' } },
    {
      comment: 2, verdict: 'confirmed', reason: 'Reproduced on line 42.',
      finding: {
        severity: 'major', category: 'correctness', kind: 'diff', file: 'src/orders/service.ts', line: 42, end_line: 44,
        title: 'Discount applied twice', problem: 'The coupon discount is applied twice.',
      },
    },
    { comment: 3, verdict: 'duplicate', duplicate_of: 1, reason: 'Same as finding 1.' },
  ],
  conclusion: 'One real defect the review missed.',
};

const reviewerScript = `
printf '%s' "$1" > "$PROMPT_DIR/$$.txt"
case "$1" in
  *"Your job: conclusion"*) printf '%s\\n' "$CONCLUSION_JSON" ;;
  *"Your job: synthesis"*) printf '%s\\n' "$SYNTH_JSON" ;;
  *) printf '%s\\n' '{"findings":[],"observations":[]}' ;;
esac
`;

const fakeReviewer: ReviewerDefinition = {
  name: 'claude',
  label: 'Fake reviewer',
  defaultModel: 'fake', defaultModelEnv: 'REVIEW_MODEL',
  bin: '/bin/sh',
  buildArgs: (prompt) => ['-c', reviewerScript, 'sh', prompt],
  buildChildEnv: () => ({
    PATH: process.env.PATH,
    PROMPT_DIR: prompts,
    SYNTH_JSON: JSON.stringify(synthesis),
    CONCLUSION_JSON: JSON.stringify(conclusion),
  }),
  parseStreamLine: (line) => ({ result: line }),
  discoverModels: async () => ({ models: [], source: null, fetchedAt: Date.now(), hint: null }),
  isAvailable: () => true,
  describeFailure: () => null,
};

// The provider's environment is the reviewers' allowlist, so the script has its paths baked in.
const modeFile = path.join(root, 'ocr-mode');
const argsFile = path.join(root, 'ocr-args');
const startedFile = path.join(root, 'ocr-started');
const emptyOutput = path.join(root, 'ocr-empty.json');
fs.writeFileSync(emptyOutput, JSON.stringify({ status: 'complete', summary: { files_reviewed: 1, total_tokens: 1200 }, comments: [] }));
const fakeOcr = path.join(bin, 'fake-ocr');
fs.writeFileSync(fakeOcr, `#!/bin/sh
printf '%s\\n' "$@" > "${argsFile}"
out=""
while [ $# -gt 0 ]; do
  if [ "$1" = "--output" ]; then out="$2"; fi
  shift
done
mode=$(cat "${modeFile}")
case "$mode" in
  ok)
    cat "${path.join(FIXTURES, 'ocr-review-stderr.txt')}" >&2
    cp "${path.join(FIXTURES, 'ocr-review-output.json')}" "$out" ;;
  empty)
    echo "[ocr] 1 file(s) changed, reviewing 1" >&2
    cp "${emptyOutput}" "$out" ;;
  fail)
    echo "[ocr] 1 file(s) changed, reviewing 1" >&2
    echo "error: provider returned 500" >&2
    exit 2 ;;
  hang)
    touch "${startedFile}"
    sleep 37 & sleep 37 & wait ;;
esac
`, { mode: 0o755 });

function setMode(mode: 'ok' | 'empty' | 'fail' | 'hang'): void {
  fs.writeFileSync(modeFile, mode);
  fs.rmSync(prompts, { recursive: true, force: true });
  fs.mkdirSync(prompts);
  fs.rmSync(startedFile, { force: true });
}

const sentPrompts = () => fs.readdirSync(prompts).map((f) => fs.readFileSync(path.join(prompts, f), 'utf8'));

const review: RunnableReview = {
  id: 7, repo: 'test-repo', branch: 'feat/orders', reviewer: 'claude', model: 'fake',
  ticket_key: 'ABC-7', ticket_title: 'Order totals', ticket_url: null, ticket_body: 'Apply the discount once.',
};

function request(states: SecondOpinionState[], overrides: Partial<SecondOpinionRequest> = {}): SecondOpinionRequest {
  return {
    provider: createOcrProvider(fakeOcr),
    requestedAt: '2026-01-01T00:00:00.000Z',
    onUpdate: (s) => states.push(s),
    workDir: path.join(root, 'work'),
    timeoutMs: 30_000,
    ...overrides,
  };
}

const baseOpts = { reviewerDefinition: fakeReviewer, timeoutMs: 30_000, rules: { text: 'Use the service layer.', files: ['_all.md'] }, checksConfig: null };

test.after(() => {
  for (const pgid of liveReviewerGroups()) {
    try { process.kill(-pgid, 'SIGKILL'); } catch { /* gone */ }
  }
  fs.rmSync(root, { recursive: true, force: true });
});

test('a second opinion runs after the review, its comments are assessed, and confirmed ones change the verdict', async () => {
  setMode('ok');
  const logs: string[] = [];
  const states: SecondOpinionState[] = [];
  const groups: RecordedGroup[][] = [];
  const out = await runReview(review, checkout, null, (_l, m) => logs.push(m), {
    ...baseOpts, onProcessGroups: (g) => groups.push(g), secondOpinion: request(states),
  });

  // The primary finding is kept, corroborated; the confirmed comment is appended and anchored.
  assert.equal(out.findings.length, 2);
  assert.equal(out.findings[0]!.title, 'Primary finding');
  assert.equal(out.findings[0]!.corroborated, true);
  assert.equal(out.findings[1]!.lens, 'second_opinion');
  assert.equal(out.findings[1]!.anchor_status, 'ok');
  assert.deepEqual(out.observations, [
    { file: 'docs/orders.md', line: 7, note: 'Worth a look later.', rationale: '', lens: 'second_opinion' },
  ]);
  assert.equal(out.verdict, 'changes_requested');
  assert.equal(out.can_merge, false);

  const state = out.second_opinion!;
  assert.equal(state.status, 'done');
  assert.equal(state.primary_verdict, 'approve');
  assert.equal(state.primary_can_merge, true);
  assert.deepEqual(state.counts, { confirmed: 1, duplicate: 1, observation: 1, rejected: 0, not_assessed: 0 });
  assert.equal(state.comments_total, 3);
  assert.deepEqual(state.comments.map((c) => [c.path, c.assessment?.verdict, c.assessment?.finding_ord]), [
    ['docs/orders.md', 'observation', null],
    ['src/orders/service.ts', 'confirmed', 1],
    ['src/orders/service.test.ts', 'duplicate', 0],
  ]);
  assert.equal(state.conclusion, 'One real defect the review missed.');
  assert.deepEqual(state.tokens, { total: 244534, input: 231465, output: 13069 });
  assert.equal(state.model, 'example-model');
  assert.deepEqual(states.map((s) => s.status), ['running', 'running', 'done']);
  assert.equal(states[0]!.requested_at, '2026-01-01T00:00:00.000Z');

  // The run log carries the stage lines the page reads, and the provider's progress without tool calls.
  for (const line of [
    'second opinion ocr: started',
    'second opinion ocr: 3 comments, 4 files, 245k tokens, 3m12s',
    'conclusion: started',
    'conclusion: 1 confirmed, 1 duplicate, 1 observation, 0 rejected',
    'second opinion: 4 file(s) changed, reviewing 4 in /tmp/checkout',
  ]) assert.ok(logs.includes(line), line);
  assert.ok(!logs.some((l) => /[▶✔]/.test(l)));
  assert.ok(logs.indexOf('second opinion ocr: started') > logs.findIndex((l) => l.startsWith('synthesis: ')));

  // The provider ran on the exact range with the files, and was tracked like a reviewer process.
  const args = fs.readFileSync(argsFile, 'utf8').trim().split('\n');
  assert.deepEqual(args.slice(0, 7), ['review', '--repo', repo, '--from', baseSha, '--to', headSha]);
  assert.ok(groups.some((g) => g.some((p) => p.bin === 'fake-ocr')));
  assert.deepEqual(groups.at(-1), []);
  assert.deepEqual(liveReviewerGroups(), []);

  // Five lenses, synthesis, and the conclusion; the conclusion saw the primary result and the comments.
  const sent = sentPrompts();
  assert.equal(sent.length, 7);
  const conclusionPrompt = sent.find((p) => p.includes('Your job: conclusion'))!;
  assert.match(conclusionPrompt, /1\. \[minor\] src\/orders\/service\.ts:5: Primary finding\. p1/);
  assert.match(conclusionPrompt, /## Comment 2: src\/orders\/service\.ts:42-44 \(tool severity medium, category bug\)/);
  assert.match(conclusionPrompt, /Use the service layer\./);

  // Files and answers are kept for the report; the working directory is gone.
  const raw = out.secondOpinionRaw!;
  assert.equal(raw.output, fs.readFileSync(path.join(FIXTURES, 'ocr-review-output.json'), 'utf8'));
  assert.match(raw.background!, /^# ABC-7: Order totals/);
  assert.equal(JSON.parse(raw.rule!).rules[0].rule, 'Use the service layer.');
  assert.deepEqual(raw.conclusion, conclusion);
  assert.equal(fs.existsSync(path.join(root, 'work')), false);
  assert.equal(git('status', '--porcelain'), '');
});

test('a failing provider leaves the primary result and records the failure', async () => {
  setMode('fail');
  const logs: string[] = [];
  const out = await runReview(review, checkout, null, (_l, m) => logs.push(m), { ...baseOpts, secondOpinion: request([]) });
  assert.equal(out.verdict, 'approve');
  assert.equal(out.findings.length, 1);
  assert.equal(out.findings[0]!.corroborated, undefined);
  const state = out.second_opinion!;
  assert.equal(state.status, 'failed');
  assert.match(state.error!, /fake-ocr exited with code 2\n[\s\S]*error: provider returned 500/);
  assert.equal(state.primary_verdict, 'approve');
  assert.ok(logs.some((l) => l.startsWith('second opinion ocr: failed (') && l.includes('exited with code 2')));
  assert.equal(sentPrompts().filter((p) => p.includes('Your job: conclusion')).length, 0);
});

test('a provider with no comments ends the stage without a conclusion process', async () => {
  setMode('empty');
  const logs: string[] = [];
  const out = await runReview(review, checkout, null, (_l, m) => logs.push(m), { ...baseOpts, secondOpinion: request([]) });
  assert.equal(out.second_opinion!.status, 'done');
  assert.equal(out.second_opinion!.conclusion, NOTHING_FOUND);
  assert.equal(out.verdict, 'approve');
  assert.equal(sentPrompts().length, 6);
  assert.ok(!logs.includes('conclusion: started'));
  assert.ok(logs.some((l) => l.startsWith('second opinion ocr: 0 comments, 1 file, 1k tokens, ')));
});

test('cancelling while the provider runs kills it and cancels the review', async () => {
  setMode('hang');
  const controller = new AbortController();
  const groups: RecordedGroup[][] = [];
  const run = runReview(review, checkout, null, () => {}, {
    ...baseOpts, signal: controller.signal, onProcessGroups: (g) => groups.push(g), secondOpinion: request([]),
  }).catch((err: Error) => err);
  const deadline = Date.now() + 20_000;
  while (!fs.existsSync(startedFile) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
  assert.ok(fs.existsSync(startedFile), 'the provider started');
  const pgid = groups.flat().find((g) => g.bin === 'fake-ocr')!.pgid;
  controller.abort();
  const err = await run;
  assert.match((err as Error).message, /cancelled/);
  const gone = Date.now() + 3_000;
  while (isGroupAlive(pgid) && Date.now() < gone) await new Promise((r) => setTimeout(r, 20));
  assert.equal(isGroupAlive(pgid), false);
  assert.deepEqual(liveReviewerGroups(), []);
});

test('an uninstalled provider is skipped with a warning and nothing is spawned for it', async () => {
  setMode('ok');
  const logs: string[] = [];
  const out = await runReview(review, checkout, null, (_l, m) => logs.push(m), {
    ...baseOpts, secondOpinion: request([], { provider: createOcrProvider(path.join(bin, 'missing-ocr')) }),
  });
  assert.equal(out.second_opinion!.status, 'skipped');
  assert.match(out.second_opinion!.error!, /not installed/);
  assert.ok(logs.some((l) => l.startsWith('second opinion ocr: skipped (')));
  assert.equal(sentPrompts().length, 6);
});

test('without a second opinion the review is the primary pipeline alone', async () => {
  setMode('ok');
  fs.rmSync(argsFile, { force: true });
  const logs: string[] = [];
  const out = await runReview(review, checkout, null, (_l, m) => logs.push(m), baseOpts);
  assert.equal('second_opinion' in out, false);
  assert.equal('secondOpinionRaw' in out, false);
  assert.equal(sentPrompts().length, 6);
  assert.equal(fs.existsSync(argsFile), false);
  assert.ok(!logs.some((l) => /second opinion|conclusion/.test(l)));
});
