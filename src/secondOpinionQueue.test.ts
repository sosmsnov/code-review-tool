import './testEnv.js';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import Fastify from 'fastify';
import type { ReviewerDefinition, ReviewerName } from './reviewers/types.js';

/**
 * The queue's side of the second opinion: recovery closes a stage its review
 * never finished, and a re-run keeps or drops the previous provider. The
 * queue is stopped first, so a queued re-run is recorded but never processed.
 */
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'crt-so-queue-'));
process.env.DATA_DIR = path.join(root, 'data');
// The env default is a provider here, so a re-run that falls back to it is visible.
process.env.SECOND_OPINION = 'ocr';

const store = await import('./db.js');
const { recoverInterrupted, stopAllReviews } = await import('./queue.js');
const { isPidAlive } = await import('./processOwnership.js');
const { reviewRoutes } = await import('./routes/reviews.js');
const { setReviewerForTests } = await import('./reviewers/index.js');
const { createOcrProvider } = await import('./secondOpinion/ocr.js');
const { setSecondOpinionProviderForTests } = await import('./secondOpinion/index.js');
const { parseSecondOpinionState, pendingState } = await import('./secondOpinion/state.js');

function stubReviewer(name: ReviewerName): ReviewerDefinition {
  return {
    name, label: `Stub ${name}`, defaultModel: 'fake', defaultModelEnv: 'REVIEW_MODEL', bin: '/bin/true', acceptsUnlistedModels: true,
    buildArgs: () => [], buildChildEnv: () => ({}), parseStreamLine: () => ({}),
    discoverModels: async () => ({ models: [{ id: 'fake', label: 'fake' }], source: 'cli', fetchedAt: Date.now(), hint: null }),
    isAvailable: () => true, describeFailure: () => null,
  };
}
setReviewerForTests('claude', stubReviewer('claude'));
setSecondOpinionProviderForTests('ocr', { ...createOcrProvider('/nonexistent/ocr'), isAvailable: () => true });

test.after(() => {
  setReviewerForTests('claude', null);
  setSecondOpinionProviderForTests('ocr', null);
  store.db.close();
  fs.rmSync(root, { recursive: true, force: true });
});

async function deadPid(): Promise<number> {
  const child = spawn('true');
  const pid = child.pid!;
  await new Promise((resolve) => child.on('exit', resolve));
  assert.equal(isPidAlive(pid), false);
  return pid;
}

test('recovery closes a second opinion its review never finished', async () => {
  const owner = await deadPid();
  const make = (state: object | null, status = 'reviewing') => store.createReview({
    repo: 'test-repo', branch: `feat/r-${Math.random()}`, base_branch: 'main', status: status as 'reviewing',
    runner_pid: owner, runner_started_at: '2026-01-01T00:00:00.000Z',
    second_opinion: state ? JSON.stringify(state) : null,
  }).id;
  const running = make({ ...pendingState('ocr'), status: 'running', started_at: '2026-01-01T00:01:00.000Z' });
  const pending = make(pendingState('ocr'), 'queued');
  const none = make(null);
  const result = await recoverInterrupted('cli', { graceMs: 100 });
  assert.deepEqual(result.failed.sort(), [running, pending, none].sort());

  const after = (id: number) => parseSecondOpinionState(store.getReview(id)!.second_opinion);
  assert.equal(after(running)!.status, 'failed');
  assert.equal(after(running)!.error, 'interrupted by restart');
  assert.ok(after(running)!.finished_at);
  assert.equal(after(pending)!.status, 'skipped');
  assert.equal(store.getReview(none)!.second_opinion, null);
});

test('a re-run keeps the previous provider, takes none when asked, and the default when none is stored', async () => {
  // Nothing re-run here is processed: the queue refuses new work once stopped.
  await stopAllReviews('test', 100);
  const app = Fastify();
  await app.register(reviewRoutes);
  try {
    const prev = (state: object | null) => store.createReview({
      repo: 'test-repo', branch: `feat/p-${Math.random()}`, base_branch: 'main', status: 'done', reviewer: 'claude', model: 'fake',
      second_opinion: state ? JSON.stringify(state) : null,
    }).id;
    const rerun = async (id: number, payload: object) => {
      const res = await app.inject({ method: 'POST', url: `/api/reviews/${id}/rerun`, payload });
      assert.equal(res.statusCode, 201, res.body);
      return res.json().review as { id: number; second_opinion: { provider: string } | null };
    };

    const withOcr = prev({ ...pendingState('ocr'), status: 'done' });
    const inherited = await rerun(withOcr, {});
    // Served parsed, like every route that returns a review row.
    assert.equal(inherited.second_opinion!.provider, 'ocr');
    assert.equal(parseSecondOpinionState(store.getReview(inherited.id)!.second_opinion)!.provider, 'ocr');

    const dropped = await rerun(withOcr, { secondOpinion: 'none' });
    assert.equal(dropped.second_opinion, null);
    assert.equal(store.getReview(dropped.id)!.second_opinion, null);

    // A run stored without one (none chosen, or older than the stage) gets SECOND_OPINION.
    const plain = await rerun(prev(null), {});
    assert.equal(plain.second_opinion!.provider, 'ocr');
    const off = await rerun(prev(null), { secondOpinion: 'none' });
    assert.equal(off.second_opinion, null);
  } finally {
    await app.close();
  }
});
