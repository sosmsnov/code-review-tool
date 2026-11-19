import assert from 'node:assert/strict';
import test from 'node:test';
import { cardCount, deriveLensProgress, diffCounts, emptyNote, requirementsCount, shaPair } from './runView';
import type { Review } from './types';

const queued = { status: 'queued', head_sha: null, base_sha: null, files_changed: null, additions: null, deletions: null, requirements_met: null, requirements_total: null } as const;
const run = (fields: Partial<Review>): Review => ({ ...queued, ...fields }) as Review;

test('a run in progress shows pending, not zero, for what it has not measured yet', () => {
  for (const status of ['queued', 'fetching', 'reviewing'] as const) {
    const r = run({ status });
    assert.equal(diffCounts(r), 'pending', status);
    assert.equal(requirementsCount(r), 'pending', status);
    assert.equal(shaPair(r), 'pending', status);
  }
});

test('the checkout counts show as soon as they are recorded', () => {
  const r = run({ status: 'reviewing', head_sha: 'a'.repeat(40), base_sha: 'b'.repeat(40), files_changed: 6, additions: 63, deletions: 2 });
  assert.deepEqual(diffCounts(r), { files: 6, additions: 63, deletions: 2 });
  assert.equal(shaPair(r), null);
  assert.equal(requirementsCount(r), 'pending');
});

test('a finished run shows its counts, zero included', () => {
  const r = run({ status: 'done', head_sha: 'a', base_sha: 'b', files_changed: 0, additions: 0, deletions: 0, requirements_met: 0, requirements_total: 0 });
  assert.deepEqual(diffCounts(r), { files: 0, additions: 0, deletions: 0 });
  assert.equal(requirementsCount(r), '0/0 met');
  assert.equal(requirementsCount(run({ status: 'done', requirements_met: 8, requirements_total: 14 })), '8/14 met');
});

test('a run that ended before measuring shows a dash', () => {
  for (const status of ['failed', 'cancelled'] as const) {
    assert.equal(diffCounts(run({ status })), '—');
    assert.equal(requirementsCount(run({ status })), '—');
    assert.equal(shaPair(run({ status })), '—');
  }
});

test('"No issues found" is said only of a finished review', () => {
  assert.equal(emptyNote('findings', 'done'), 'No issues found.');
  assert.equal(emptyNote('requirements', 'done'), 'No requirements recorded.');
  for (const status of ['queued', 'fetching', 'reviewing'] as const) {
    assert.doesNotMatch(emptyNote('findings', status), /no issues/i);
    assert.match(emptyNote('findings', status), /once the review finishes/);
    assert.match(emptyNote('requirements', status), /once the review finishes/);
  }
  assert.doesNotMatch(emptyNote('findings', 'failed'), /no issues/i);
  assert.doesNotMatch(emptyNote('findings', 'cancelled'), /no issues/i);
});

test('a card counts only what a finished or ended run recorded', () => {
  assert.equal(cardCount('Findings', 0, 'reviewing'), 'Findings');
  assert.equal(cardCount('Findings', 0, 'done'), 'Findings (0)');
  assert.equal(cardCount('Findings', 3, 'failed'), 'Findings (3)');
});

test('lens chips come from the lens lines; the second opinion and its conclusion get their own chips', () => {
  const log = (...messages: string[]) => messages.map((message) => ({ message }));
  assert.equal(deriveLensProgress(log('Queued.', 'second opinion ocr: started')), null);

  const primaryOnly = deriveLensProgress(log('lens correctness: started', 'lens security: 1 finding, 0 observations'))!;
  assert.deepEqual(primaryOnly.map((c) => c.name), ['correctness', 'security', 'tests', 'contracts', 'regressions']);
  assert.equal(primaryOnly[0]!.state, 'running');
  assert.equal(primaryOnly[1]!.state, 'done');

  const expected = deriveLensProgress(log('lens correctness: started'), true)!;
  assert.deepEqual(expected.slice(-2).map((c) => [c.name, c.state]), [['second opinion', 'pending'], ['conclusion', 'pending']]);

  const running = deriveLensProgress(log(
    'lens correctness: 0 findings, 0 observations',
    'second opinion ocr: started',
    'second opinion: 9 file(s) changed, reviewing 9',
  ), true)!;
  assert.deepEqual(running.slice(-2).map((c) => [c.name, c.state]), [['second opinion', 'running'], ['conclusion', 'pending']]);

  const done = deriveLensProgress(log(
    'lens correctness: 0 findings, 0 observations',
    'second opinion ocr: started',
    'second opinion ocr: 7 comments, 9 files, 245k tokens, 3m12s',
    'conclusion: started',
    'conclusion: 2 confirmed, 1 duplicate, 1 observation, 3 rejected',
  ))!;
  assert.deepEqual(done.slice(-2), [
    { name: 'second opinion', state: 'done', note: '7 comments, 9 files, 245k tokens, 3m12s' },
    { name: 'conclusion', state: 'done', note: '2 confirmed, 1 duplicate, 1 observation, 3 rejected' },
  ]);

  const failed = deriveLensProgress(log('lens tests: 0 findings, 0 observations', 'second opinion ocr: failed (ocr exited with code 2)'), true)!;
  assert.deepEqual(failed.slice(-1).map((c) => [c.name, c.state]), [['second opinion', 'failed']]);

  const skipped = deriveLensProgress(log(
    'lens tests: 0 findings, 0 observations',
    'second opinion ocr: skipped (Open Code Review is not installed: ocr not found on PATH)',
  ), true)!;
  assert.deepEqual(skipped.slice(-1), [{
    name: 'second opinion', state: 'skipped', note: 'skipped (Open Code Review is not installed: ocr not found on PATH)',
  }]);

  const empty = deriveLensProgress(log('lens tests: 0 findings, 0 observations', 'second opinion ocr: 0 comments, 3 files, 12k tokens, 40s'), true)!;
  assert.deepEqual(empty.slice(-1).map((c) => [c.name, c.state]), [['second opinion', 'done']]);
});
