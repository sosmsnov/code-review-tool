import './testEnv.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import Fastify from 'fastify';
import { gitCompare, makeStack } from './testGit.js';
import type { ResolvedTarget, ReviewRow, TicketInfo } from './types.js';

/**
 * Skipping unchanged branches in a ticket batch, and the usage budget guard,
 * with the tracker, GitHub and the queue stubbed: one repository, main -> a -> b.
 */
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'crt-skip-'));
const repoDir = path.join(root, 'svc');
const A = 'feat/abc-7-a';
const B = 'feat/abc-7-b';
makeStack(repoDir, A, B);
process.env.DATA_DIR = path.join(root, 'data');
process.env.ALLOWED_REPOS = 'svc';
process.env.USAGE_BUDGET_WEIGHTED = '1000';

const store = await import('./db.js');
const { ticketGroupRoutes } = await import('./routes/ticketGroups.js');
type TicketRouteDeps = import('./routes/ticketGroups.js').TicketRouteDeps;
const { reviewRoutes } = await import('./routes/reviews.js');
const { setReviewerForTests } = await import('./reviewers/index.js');
const { skipUnchanged } = await import('./skipUnchanged.js');
const { collectCoverageInputs } = await import('./coverage.js');
const { budgetRefusal, usageWindow } = await import('./budget.js');
const ticketStore = await import('./ticketStore.js');

setReviewerForTests('claude', {
  name: 'claude', label: 'Claude Code', defaultModel: 'opus', defaultModelEnv: 'REVIEW_MODEL', bin: '/bin/true',
  buildArgs: () => [], buildChildEnv: () => ({}), parseStreamLine: () => ({}),
  discoverModels: async () => ({ models: [{ id: 'opus', label: 'opus' }], source: 'cli-cache', fetchedAt: Date.now(), hint: null }),
  isAvailable: () => true,
  describeFailure: () => null,
  acceptsUnlistedModels: true,
});

const KEY = 'ABC-7';
const ticket: TicketInfo = {
  provider: 'linear', key: KEY, title: 'Export', url: 'https://tracker.example/ABC-7', body: 'Export risks.',
  state: 'Todo', branchName: null, comments: [], attachmentUrls: [],
};
const resolved: ResolvedTarget[] = [A, B].map((branch) => ({ repo: 'svc', branch, baseBranch: 'main', prNumber: null }));

const started: string[] = [];
const heads = new Map<string, string>([[A, 'a'.repeat(40)], [B, 'b'.repeat(40)]]);

const app = Fastify({ logger: false });
const deps: Partial<TicketRouteDeps> = {
  resolve: async () => ({ ticket, targets: resolved, fromTicket: true }),
  detect: {
    compare: async (_repo, base, head) => gitCompare(repoDir, base, head),
    defaultBranch: async () => 'main',
    localParent: async () => { throw new Error('not local'); },
  },
  startRun: (target, t, reviewer, _model, opts) => {
    started.push(`${target.repo}#${target.branch}`);
    return store.createReview({
      depends_on: opts?.dependsOn ?? null,
      ticket_key: t?.key || null, ticket_title: t?.title ?? null, ticket_body: t?.body ?? null,
      repo: target.repo, branch: target.branch, base_branch: target.baseBranch, status: 'queued',
      base_reason: target.baseReason ?? null, reviewer: reviewer ?? 'claude',
    });
  },
  recompute: () => ({ started: true, done: Promise.resolve() }),
  pending: () => false,
  headOf: async (t) => heads.get(t.branch) ?? null,
};
await app.register(ticketGroupRoutes, { deps });
await app.register(reviewRoutes);

test.after(async () => {
  setReviewerForTests('claude', null);
  await app.close();
  store.db.close();
  fs.rmSync(root, { recursive: true, force: true });
});

/** Every queued run of the batch finishes on the head the stub reports now. */
function finishAll(): void {
  for (const r of store.db.prepare<[], ReviewRow>(`SELECT * FROM reviews WHERE status = 'queued'`).all()) {
    store.updateReview(r.id, { status: 'done', head_sha: heads.get(r.branch)!, finished_at: new Date().toISOString() });
  }
}

const review = (payload: object) => app.inject({ method: 'POST', url: `/api/tickets/${KEY}/review`, payload });

test('a ticket batch skips a branch whose head equals its latest finished review, and reviews the changed one', async () => {
  const first = await review({ reviewer: 'claude' });
  assert.equal(first.statusCode, 201, first.body);
  assert.deepEqual(first.json().skipped, []);
  assert.deepEqual(started.splice(0), [`svc#${A}`, `svc#${B}`]);
  finishAll();
  const doneA = store.db.prepare<[string], ReviewRow>(`SELECT * FROM reviews WHERE branch = ? AND status = 'done'`).get(A)!;

  heads.set(B, 'c'.repeat(40));
  const second = await review({ reviewer: 'claude' });
  assert.equal(second.statusCode, 201, second.body);
  assert.deepEqual(started.splice(0), [`svc#${B}`]);
  assert.deepEqual(second.json().skipped, [{
    repo: 'svc', branch: A, head_sha: 'a'.repeat(40), review_id: doneA.id, reason: `unchanged since review ${doneA.id}`,
  }]);
  assert.deepEqual(second.json().run.review_ids, second.json().reviews.map((r: ReviewRow) => r.id));

  // Coverage still reads every branch: the skipped one through its latest finished review.
  finishAll();
  const inputs = collectCoverageInputs(KEY);
  const byBranch = new Map(inputs.branches.map((b) => [b.member.branch, b.review?.id ?? null]));
  assert.equal(byBranch.get(A), doneA.id);
  assert.equal(byBranch.get(B), second.json().reviews[0].id);
});

test('reviewUnchanged reviews every branch; a batch with nothing changed queues nothing', async () => {
  const forced = await review({ reviewer: 'claude', reviewUnchanged: true });
  assert.equal(forced.statusCode, 201, forced.body);
  assert.deepEqual(forced.json().skipped, []);
  assert.deepEqual(started.splice(0), [`svc#${A}`, `svc#${B}`]);
  finishAll();

  const idle = await review({ reviewer: 'claude' });
  assert.equal(idle.statusCode, 200, idle.body);
  assert.deepEqual(started.splice(0), []);
  assert.equal(idle.json().run, null);
  assert.deepEqual(idle.json().skipped.map((s: { branch: string }) => s.branch), [A, B]);
});

test('skipUnchanged: another base, a working tree, an unreadable head, or no group means review it', async () => {
  const groupOf = () => KEY;
  const same = { repo: 'svc', branch: A, baseBranch: 'main', prNumber: null } satisfies ResolvedTarget;
  assert.equal((await skipUnchanged([same], groupOf, async () => 'a'.repeat(40))).skipped.length, 1);
  const cases: [ResolvedTarget, () => string | null, () => Promise<string | null>][] = [
    [{ ...same, baseBranch: 'develop' }, groupOf, async () => 'a'.repeat(40)],
    [{ ...same, source: 'local', includeWorkingTree: true }, groupOf, async () => 'a'.repeat(40)],
    [same, groupOf, async () => null],
    [same, groupOf, async () => 'd'.repeat(40)],
    [same, () => null, async () => 'a'.repeat(40)],
  ];
  for (const [target, group, head] of cases) {
    const out = await skipUnchanged([target], group, head);
    assert.deepEqual(out, { run: [target], skipped: [] });
  }
});

// --- the budget guard: last, since it spends the budget -------------------------------------

test('GET /api/usage sums the window; a spent budget refuses starts with 409 unless ignoreBudget', async () => {
  const before = (await app.inject({ method: 'GET', url: '/api/usage' })).json();
  assert.equal(before.budget, 1000);
  assert.equal(before.window_hours, 5);
  assert.equal(before.used, 0);
  assert.equal(before.remaining, 1000);

  const spent = store.createReview({ repo: 'svc', branch: A, base_branch: 'main', status: 'queued' });
  const usage = { passes: [], totals: { input: 0, cache_read: 0, cache_write: 0, output: 0, cost_usd: null, weighted: 700, processes: 1 } };
  store.updateReview(spent.id, { status: 'done', usage: JSON.stringify(usage), finished_at: new Date().toISOString() });
  const coverage = ticketStore.createCoverage(KEY, { reviewIds: [], reviewer: 'claude', model: 'opus', trigger: 'test' });
  ticketStore.setCoverageUsage(coverage.id, { passes: [], totals: { ...usage.totals, weighted: 400 } });
  // Older than the window: not counted.
  const old = store.createReview({ repo: 'svc', branch: A, base_branch: 'main', status: 'queued' });
  store.updateReview(old.id, { status: 'done', usage: JSON.stringify(usage), finished_at: '2000-01-01T00:00:00.000Z' });

  const after = (await app.inject({ method: 'GET', url: '/api/usage' })).json();
  assert.equal(after.used, 1100);
  assert.equal(after.remaining, 0);
  assert.equal(after.coverage_passes, 1);
  assert.equal(usageWindow().used, 1100);
  assert.equal(budgetRefusal(true), null);

  const create = await app.inject({ method: 'POST', url: '/api/reviews', payload: { input: 'svc#feat/x' } });
  assert.equal(create.statusCode, 409);
  assert.match(create.json().error, /usage budget .* is spent \(1100 of 1000/);
  assert.equal(create.json().usage.used, 1100);
  const rerun = await app.inject({ method: 'POST', url: `/api/reviews/${spent.id}/rerun`, payload: {} });
  assert.equal(rerun.statusCode, 409);
  const ticketRun = await review({ reviewer: 'claude' });
  assert.equal(ticketRun.statusCode, 409);

  const forced = await review({ reviewer: 'claude', ignoreBudget: true, reviewUnchanged: true });
  assert.equal(forced.statusCode, 201, forced.body);
  const forcedRerun = await app.inject({ method: 'POST', url: `/api/reviews/${spent.id}/rerun`, payload: { ignoreBudget: true } });
  assert.equal(forcedRerun.statusCode, 201, forcedRerun.body);
});

test('review rows carry their usage: parsed on the detail route, usage_weighted on the list', async () => {
  const row = store.db.prepare<[], ReviewRow>(`SELECT * FROM reviews WHERE usage IS NOT NULL ORDER BY id DESC LIMIT 1`).get()!;
  const detail = (await app.inject({ method: 'GET', url: `/api/reviews/${row.id}` })).json();
  assert.equal(detail.review.usage.totals.weighted, 700);
  const list = (await app.inject({ method: 'GET', url: '/api/reviews?limit=500' })).json();
  const listed = list.reviews.find((r: { id: number }) => r.id === row.id);
  assert.equal(listed.usage_weighted, 700);
  assert.equal('usage' in listed, false);
});
