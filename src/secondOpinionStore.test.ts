import './testEnv.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import Fastify from 'fastify';
import type { ReviewerDefinition, ReviewerName } from './reviewers/types.js';
import type { SecondOpinionState } from './secondOpinion/types.js';
import type { Finding, ReviewOutput } from './types.js';

/** The stored second opinion: the columns, the review routes, /api/reviewers, and the report. */
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'crt-so-store-'));
process.env.DATA_DIR = path.join(root, 'data');

const store = await import('./db.js');
const { reviewRoutes } = await import('./routes/reviews.js');
const { reviewerRoutes } = await import('./routes/reviewers.js');
const { renderReport } = await import('./reportWriter.js');
const { setReviewerForTests } = await import('./reviewers/index.js');
const { createOcrProvider } = await import('./secondOpinion/ocr.js');
const { setSecondOpinionProviderForTests } = await import('./secondOpinion/index.js');
const { pendingState } = await import('./secondOpinion/state.js');

test.after(() => {
  for (const name of ['claude', 'cursor', 'codex', 'grok'] as const) setReviewerForTests(name, null);
  setSecondOpinionProviderForTests('ocr', null);
  store.db.close();
  fs.rmSync(root, { recursive: true, force: true });
});

function stubReviewer(name: ReviewerName): ReviewerDefinition {
  return {
    name, label: `Stub ${name}`, defaultModel: 'fake', defaultModelEnv: 'REVIEW_MODEL', bin: '/bin/true', acceptsUnlistedModels: true,
    buildArgs: () => [], buildChildEnv: () => ({}), parseStreamLine: () => ({}),
    discoverModels: async () => ({ models: [{ id: 'fake', label: 'fake' }], source: 'cli', fetchedAt: Date.now(), hint: null }),
    isAvailable: () => true, describeFailure: () => null,
  };
}
for (const name of ['claude', 'cursor', 'codex', 'grok'] as const) setReviewerForTests(name, stubReviewer(name));
setSecondOpinionProviderForTests('ocr', { ...createOcrProvider('/nonexistent/ocr'), isAvailable: () => false });

function doneState(): SecondOpinionState {
  return {
    ...pendingState('ocr', '2026-01-01T00:00:00.000Z'),
    status: 'done',
    started_at: '2026-01-01T00:01:00.000Z',
    finished_at: '2026-01-01T00:05:00.000Z',
    elapsed_ms: 192_000,
    model: 'example-model',
    tokens: { total: 244_534, input: 231_465, output: 13_069 },
    files_reviewed: 4,
    comments_total: 3,
    counts: { confirmed: 1, duplicate: 1, observation: 0, rejected: 1, not_assessed: 0 },
    comments: [
      {
        path: 'src/orders/service.ts', start_line: 42, end_line: 44, severity: 'medium', category: 'bug', content: 'Discount twice.',
        assessment: { verdict: 'confirmed', reason: 'Reproduced.', duplicate_of: null, finding_ord: 1 },
      },
      {
        path: 'src/orders/service.ts', start_line: 5, end_line: 5, severity: 'low', category: 'bug', content: 'Same as before.',
        assessment: { verdict: 'duplicate', reason: 'Same as finding 1.', duplicate_of: 1, finding_ord: 0 },
      },
      {
        path: 'docs/orders.md', start_line: 7, end_line: 7, severity: 'high', category: 'documentation', content: 'Old | rule.',
        assessment: { verdict: 'rejected', reason: 'The doc is right.', duplicate_of: null, finding_ord: null },
      },
    ],
    conclusion: 'One real defect the review missed.',
    primary_verdict: 'approve',
    primary_can_merge: true,
  };
}

function finding(overrides: Partial<Finding>): Finding {
  return {
    severity: 'minor', category: 'correctness', file: 'src/orders/service.ts', line: 5, end_line: null, title: 'Primary finding',
    problem: 'p', why: '', suggestion: '', snippet: null, kind: 'diff', cause_file: null, cause_line: null, hunk: null,
    lens: 'correctness', anchor_status: 'ok', ...overrides,
  };
}

test('the second opinion and the corroborated mark are stored; a row without them reads null', () => {
  const state = doneState();
  const row = store.createReview({ repo: 'test-repo', branch: 'feat/a', base_branch: 'main', second_opinion: JSON.stringify(state) });
  assert.deepEqual(JSON.parse(store.getReview(row.id)!.second_opinion!), state);
  store.replaceFindings(row.id, [finding({ corroborated: true }), finding({ title: 'New', lens: 'second_opinion' })]);
  assert.deepEqual(store.getFindings(row.id).map((f) => [f.title, f.corroborated, f.lens]), [
    ['Primary finding', 1, 'correctness'],
    ['New', null, 'second_opinion'],
  ]);
  const plain = store.createReview({ repo: 'test-repo', branch: 'feat/b', base_branch: 'main' });
  assert.equal(store.getReview(plain.id)!.second_opinion, null);
});

test('the detail serves the second opinion parsed, the list only its summary', async () => {
  const row = store.createReview({ repo: 'test-repo', branch: 'feat/c', base_branch: 'main', second_opinion: JSON.stringify(doneState()) });
  const app = Fastify();
  await app.register(reviewRoutes);
  try {
    const detail = (await app.inject({ method: 'GET', url: `/api/reviews/${row.id}` })).json();
    assert.deepEqual(detail.review.second_opinion, doneState());
    const list = (await app.inject({ method: 'GET', url: '/api/reviews?branch=feat/c' })).json();
    assert.deepEqual(list.reviews[0].second_opinion, {
      provider: 'ocr', status: 'done', comments_total: 3,
      counts: { confirmed: 1, duplicate: 1, observation: 0, rejected: 1, not_assessed: 0 },
      primary_verdict: 'approve', elapsed_ms: 192_000, tokens_total: 244_534, error: null,
    });
    const plain = store.createReview({ repo: 'test-repo', branch: 'feat/d', base_branch: 'main' });
    assert.equal((await app.inject({ method: 'GET', url: `/api/reviews/${plain.id}` })).json().review.second_opinion, null);
  } finally {
    await app.close();
  }
});

test('asking for a provider that is not installed is refused before anything is queued', async () => {
  const app = Fastify();
  await app.register(reviewRoutes);
  try {
    const before = store.listReviews({ limit: 500 }).total;
    const res = await app.inject({
      method: 'POST', url: '/api/reviews', payload: { input: 'test-repo#feat/x', model: 'fake', secondOpinion: 'ocr' },
    });
    assert.equal(res.statusCode, 400);
    assert.match(res.json().error, /Open Code Review is not installed: \/nonexistent\/ocr not found on PATH/);
    assert.equal((await app.inject({ method: 'POST', url: '/api/reviews', payload: { input: 'x', secondOpinion: 'other' } })).statusCode, 400);

    const prev = store.createReview({ repo: 'test-repo', branch: 'feat/e', base_branch: 'main', status: 'done', model: 'fake' });
    const rerun = await app.inject({ method: 'POST', url: `/api/reviews/${prev.id}/rerun`, payload: { secondOpinion: 'ocr' } });
    assert.equal(rerun.statusCode, 400);
    assert.match(rerun.json().error, /not installed/);
    assert.equal(store.listReviews({ limit: 500 }).total, before + 1);
  } finally {
    await app.close();
  }
});

test('a cancel serves the row with its second opinion parsed and closed', async () => {
  const row = store.createReview({
    repo: 'test-repo', branch: 'feat/cancel', base_branch: 'main', status: 'queued', second_opinion: JSON.stringify(pendingState('ocr')),
  });
  const app = Fastify();
  await app.register(reviewRoutes);
  try {
    const res = await app.inject({ method: 'POST', url: `/api/reviews/${row.id}/cancel` });
    assert.equal(res.statusCode, 200, res.body);
    const review = res.json().review;
    assert.equal(review.status, 'cancelled');
    assert.equal(review.second_opinion.provider, 'ocr');
    assert.equal(review.second_opinion.status, 'skipped');
    assert.equal(review.second_opinion.error, 'cancelled');
  } finally {
    await app.close();
  }
});

test('GET /api/reviewers lists the second-opinion providers and the default', async () => {
  const app = Fastify();
  await app.register(reviewerRoutes);
  try {
    const body = (await app.inject({ method: 'GET', url: '/api/reviewers' })).json();
    assert.deepEqual(body.second_opinion, {
      providers: [{ name: 'ocr', label: 'Open Code Review', available: false, hint: 'Open Code Review is not installed: /nonexistent/ocr not found on PATH' }],
      default: 'none',
    });
  } finally {
    await app.close();
  }
});

test('the report has a second opinion section, tags its findings, and marks corroborated ones', () => {
  const output: ReviewOutput = {
    summary: 's', requirements: [{ text: 'r', status: 'met', evidence: 'e' }],
    findings: [finding({ corroborated: true }), finding({ title: 'Discount applied twice', severity: 'major', line: 42, lens: 'second_opinion' })],
    observations: [{ file: 'docs/orders.md', line: 7, note: 'Worth a look.', rationale: '', lens: 'second_opinion' }],
    verdict: 'changes_requested', can_merge: false, conclusion: 'Fix the discount.', second_opinion: doneState(),
  };
  const review = {
    id: 1, repo: 'test-repo', branch: 'feat/a', base_branch: 'main', run_index: 1, head_sha: 'h'.repeat(40), base_sha: 'b'.repeat(40),
    reviewer: 'claude', model: 'fake', ticket_key: null, ticket_title: null, ticket_url: null,
  };
  const checkout = { dir: '/x', headSha: 'h'.repeat(40), baseSha: 'b'.repeat(40), filesChanged: 1, additions: 1, deletions: 1, changedFiles: [] };
  const md = renderReport(review, null, checkout, output);
  assert.match(md, /### 1\. \[MAJOR\] Discount applied twice \(second opinion\)/);
  assert.match(md, /- \*\*Also found by:\*\* the second opinion \(ocr\)/);
  const section = md.slice(md.indexOf('## Second opinion'), md.indexOf('## Suggestions'));
  assert.ok(md.indexOf('## Issues to fix') < md.indexOf('## Second opinion'));
  assert.match(section, /\| Provider \| ocr · model example-model \|/);
  assert.match(section, /\| Tokens \| 245k \(231k in, 13k out\) \|/);
  assert.match(section, /\| Comments \| 3: 1 confirmed, 1 duplicate, 0 observations, 1 rejected \|/);
  assert.match(section, /\| Verdict \| approve -> changes_requested \|/);
  assert.match(section, /\| 1 \| `src\/orders\/service\.ts:42-44` \| medium \| confirmed: "Discount applied twice" \| Discount twice\. \| Reproduced\. \|/);
  assert.match(section, /\| 2 \| `src\/orders\/service\.ts:5` \| low \| duplicate of "Primary finding" \|/);
  assert.match(section, /Old \\\| rule\./);
  assert.match(section, /### Conclusion of the second opinion\n\nOne real defect the review missed\./);
  assert.match(md, /`docs\/orders\.md:7` \u2014 \(second opinion\) Worth a look\./);

  const without = renderReport(review, null, checkout, { ...output, second_opinion: undefined, findings: [finding({})], observations: [] });
  assert.doesNotMatch(without, /Second opinion|second opinion|Also found by/);
});
