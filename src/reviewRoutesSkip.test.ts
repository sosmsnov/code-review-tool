import './testEnv.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import Fastify from 'fastify';
import type { ResolvedTarget, TicketInfo } from './types.js';

/**
 * POST /api/reviews and the skip rule, with the resolver, the head lookup, and
 * the queue stubbed: only a ticket input skips a branch that its latest done
 * review already saw, whatever the number of branches.
 */
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'crt-review-skip-'));
process.env.DATA_DIR = path.join(root, 'data');
process.env.ALLOWED_REPOS = 'svc';
process.env.USAGE_BUDGET_WEIGHTED = '0';

const store = await import('./db.js');
const ticketStore = await import('./ticketStore.js');
const { reviewRoutes } = await import('./routes/reviews.js');
const { setReviewerForTests } = await import('./reviewers/index.js');

setReviewerForTests('claude', {
  name: 'claude', label: 'Claude Code', defaultModel: 'opus', defaultModelEnv: 'REVIEW_MODEL', bin: '/bin/true',
  buildArgs: () => [], buildChildEnv: () => ({}), parseStreamLine: () => ({}),
  discoverModels: async () => ({ models: [{ id: 'opus', label: 'opus' }], source: 'cli-cache', fetchedAt: Date.now(), hint: null }),
  isAvailable: () => true,
  describeFailure: () => null,
  acceptsUnlistedModels: true,
});

const KEY = 'ABC-9';
const BRANCH = 'feat/abc-9-a';
const HEAD = 'a'.repeat(40);
const ticket: TicketInfo = {
  provider: 'linear', key: KEY, title: 'Export', url: 'https://tracker.example/ABC-9', body: 'Export risks.',
  state: 'Todo', branchName: null, comments: [], attachmentUrls: [],
};
const target: ResolvedTarget = { repo: 'svc', branch: BRANCH, baseBranch: 'main', prNumber: null };

let fromTicket = true;
const started: string[] = [];
const app = Fastify({ logger: false });
await app.register(reviewRoutes, {
  resolve: async () => ({ ticket, targets: [target], fromTicket }),
  headOf: async () => HEAD,
  startRun: (t: ResolvedTarget, tk: TicketInfo | null, reviewer?: string) => {
    started.push(`${t.repo}#${t.branch}`);
    return store.createReview({
      ticket_key: tk?.key || null, ticket_title: tk?.title ?? null, ticket_body: tk?.body ?? null,
      repo: t.repo, branch: t.branch, base_branch: t.baseBranch, status: 'queued', reviewer: reviewer ?? 'claude',
    });
  },
});

test.after(async () => {
  setReviewerForTests('claude', null);
  await app.close();
  store.db.close();
  fs.rmSync(root, { recursive: true, force: true });
});

const doneReview = store.createReview({
  ticket_key: KEY, repo: 'svc', branch: BRANCH, base_branch: 'main', status: 'queued',
});
store.updateReview(doneReview.id, { status: 'done', head_sha: HEAD, finished_at: new Date().toISOString() });
ticketStore.syncMembersFromReviews(KEY);

const post = (payload: object) => app.inject({ method: 'POST', url: '/api/reviews', payload });

test('a ticket input with one unchanged branch queues nothing and lists the branch under skipped', async () => {
  fromTicket = true;
  const res = await post({ input: KEY });
  assert.equal(res.statusCode, 200, res.body);
  assert.deepEqual(res.json().reviews, []);
  assert.deepEqual(res.json().skipped, [{
    repo: 'svc', branch: BRANCH, head_sha: HEAD, review_id: doneReview.id, reason: `unchanged since review ${doneReview.id}`,
  }]);
  assert.deepEqual(started, []);
});

test('a repo#branch input with the same head is reviewed, never skipped', async () => {
  fromTicket = false;
  const res = await post({ input: `svc#${BRANCH}` });
  assert.equal(res.statusCode, 201, res.body);
  assert.equal(res.json().reviews.length, 1);
  assert.deepEqual(res.json().skipped, []);
  assert.deepEqual(started.splice(0), [`svc#${BRANCH}`]);
});

test('a ticket input with reviewUnchanged reviews the unchanged branch', async () => {
  fromTicket = true;
  const res = await post({ input: KEY, reviewUnchanged: true });
  assert.equal(res.statusCode, 201, res.body);
  assert.equal(res.json().reviews.length, 1);
  assert.deepEqual(res.json().skipped, []);
  assert.deepEqual(started.splice(0), [`svc#${BRANCH}`]);
});
