import './testEnv.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { parseAnthropicStreamLine } from './reviewers/anthropicStream.js';
import { parseCodexStreamLine } from './reviewers/codexStream.js';
import { claudeReviewer } from './reviewers/claude.js';
import { codexReviewer } from './reviewers/codex.js';
import { cursorReviewer } from './reviewers/cursor.js';
import { grokReviewer } from './reviewers/grok.js';
import type { PassLimits, ReviewerDefinition } from './reviewers/types.js';
import { config } from './config.js';
import { liveReviewerGroups, runReview, spawnReviewer, type RunnableReview } from './reviewRunner.js';
import { secondOpinionUsage } from './secondOpinion/run.js';
import { renderUsage } from './reportWriter.js';
import type { CheckoutResult } from './types.js';
import {
  DEFAULT_USAGE_WEIGHTS, parseUsageWeights, sumTotals, usageTotalsLine, UsageMeter, weightedTokens, type PassUsage,
} from './usage.js';

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
const noLog = () => {};

// --- parsing -------------------------------------------------------------------

test('the usage of a captured Claude Code result event is read, with the cost and the costliest model', () => {
  const line = fs.readFileSync(path.join(FIXTURES, 'claude-result-max-turns.json'), 'utf8').trim();
  const out = parseAnthropicStreamLine(line, noLog);
  assert.deepEqual(out.usage, {
    input: 919, cache_read: 22_845, cache_write: 12_117, output: 186, cost_usd: 0.0283675, model: 'claude-haiku-4-5-20251001',
  });
  // That run stopped at its --max-turns cap.
  assert.equal(out.turnCapReached, true);
  assert.equal(out.isError, true);
});

test('modelUsage is summed over the models when present; the top-level usage is the fallback', () => {
  const event = {
    type: 'result', subtype: 'success', result: '{}', total_cost_usd: 0.5,
    usage: { input_tokens: 1, cache_read_input_tokens: 2, cache_creation_input_tokens: 3, output_tokens: 4 },
    modelUsage: {
      small: { inputTokens: 10, outputTokens: 20, cacheReadInputTokens: 30, cacheCreationInputTokens: 40, costUSD: 0.1 },
      large: { inputTokens: 100, outputTokens: 200, cacheReadInputTokens: 300, cacheCreationInputTokens: 400, costUSD: 0.4 },
    },
  };
  assert.deepEqual(parseAnthropicStreamLine(JSON.stringify(event), noLog).usage, {
    input: 110, cache_read: 330, cache_write: 440, output: 220, cost_usd: 0.5, model: 'large',
  });
  const { modelUsage: _drop, ...bare } = event;
  assert.deepEqual(parseAnthropicStreamLine(JSON.stringify(bare), noLog).usage, {
    input: 1, cache_read: 2, cache_write: 3, output: 4, cost_usd: 0.5, model: null,
  });
});

test('a result event without usage gives no usage; a successful one is no turn cap', () => {
  const out = parseAnthropicStreamLine(JSON.stringify({ type: 'result', subtype: 'success', result: '{}' }), noLog);
  assert.equal(out.usage, undefined);
  assert.equal(out.turnCapReached, undefined);
  assert.equal(out.result, '{}');
});

test('Codex: turn.completed usage, with cached tokens taken out of the input', () => {
  const lines = fs.readFileSync(path.join(FIXTURES, 'codex-turn-completed.jsonl'), 'utf8').trim().split('\n');
  const usages = lines.map((l) => parseCodexStreamLine(l, noLog).usage).filter(Boolean);
  assert.deepEqual(usages, [{ input: 1_829, cache_read: 12_288, cache_write: 0, output: 5, cost_usd: null, model: null }]);
});

// --- weights and totals ----------------------------------------------------------

const u = (over: Partial<PassUsage> = {}): PassUsage => ({
  input: 0, cache_read: 0, cache_write: 0, output: 0, cost_usd: null, model: null, ...over,
});

test('weighted = input + cache_write * 1.25 + cache_read * 0.1 + output * 5 by default', () => {
  assert.deepEqual(DEFAULT_USAGE_WEIGHTS, { input: 1, cache_write: 1.25, cache_read: 0.1, output: 5 });
  assert.deepEqual(config.USAGE_WEIGHTS, DEFAULT_USAGE_WEIGHTS);
  const usage = u({ input: 100, cache_write: 1_000, cache_read: 10_000, output: 20 });
  assert.equal(weightedTokens(usage, DEFAULT_USAGE_WEIGHTS), 100 + 1_250 + 1_000 + 100);
  assert.equal(weightedTokens(null, DEFAULT_USAGE_WEIGHTS), 0);
});

test('USAGE_WEIGHTS: keys override the defaults; unknown keys and bad numbers are refused', () => {
  assert.deepEqual(parseUsageWeights(undefined), DEFAULT_USAGE_WEIGHTS);
  assert.deepEqual(parseUsageWeights(' output=4, cache_read=0 '), { input: 1, cache_write: 1.25, cache_read: 0, output: 4 });
  assert.throws(() => parseUsageWeights('outputs=4'), /unknown weight/);
  assert.throws(() => parseUsageWeights('output=-1'), /non-negative/);
  assert.throws(() => parseUsageWeights('output='), /non-negative/);
});

test('the meter sums processes per pass and totals over passes; a pass without usage still counts its process', () => {
  const meter = new UsageMeter(DEFAULT_USAGE_WEIGHTS);
  meter.record('lens:security', u({ cache_read: 1_000_000, cache_write: 80_000, output: 6_000, cost_usd: 0.5 }));
  meter.record('lens:security', u({ cache_read: 200_000, cache_write: 10_000, output: 2_000 }));
  meter.record('synthesis', null);
  const { passes, totals } = meter.summary();
  assert.deepEqual(passes.map((p) => [p.name, p.processes, p.weighted]), [
    ['lens:security', 2, 120_000 + 112_500 + 40_000],
    ['synthesis', 1, 0],
  ]);
  assert.deepEqual(totals, {
    input: 0, cache_read: 1_200_000, cache_write: 90_000, output: 8_000, cost_usd: 0.5, weighted: 272_500, processes: 3,
  });
  assert.equal(usageTotalsLine(totals), '1.2M read, 90k written, 8k out, weighted 273k, 3 processes');
  assert.equal(sumTotals([totals, null, totals]).weighted, 545_000);
  assert.equal(sumTotals([]).cost_usd, null);
});

test('the second opinion takes reported cache tokens out of its input', () => {
  assert.deepEqual(
    secondOpinionUsage({ total: 1_000, input: 900, output: 100, cache_read: 300, cache_write: 500 }, 'm'),
    u({ input: 100, cache_read: 300, cache_write: 500, output: 100, model: 'm' }),
  );
  assert.deepEqual(secondOpinionUsage({ total: 100, input: 50, output: 50, cache_read: 40, cache_write: 40 }), u({ cache_read: 40, cache_write: 40, output: 50 }));
});

test('without reported cache numbers the second opinion counts its input as written to the cache', () => {
  assert.deepEqual(secondOpinionUsage({ total: 1_000, input: 900, output: 100 }, 'm'), u({ cache_write: 900, output: 100, model: 'm' }));
  assert.deepEqual(secondOpinionUsage({ total: 1_000, input: 0, output: 100 }), u({ cache_write: 900, output: 100 }));
});

test('the report has a Usage section with one row per pass', () => {
  const meter = new UsageMeter(DEFAULT_USAGE_WEIGHTS);
  meter.record('synthesis', u({ cache_read: 50_000, output: 1_000 }));
  const lines: string[] = [];
  renderUsage(lines, meter.summary());
  assert.equal(lines[0], '## Usage');
  assert.match(lines.join('\n'), /\| synthesis \| 1 \| 50k \| 0 \| 1k \| 10k \|/);
});

// --- turn caps ---------------------------------------------------------------------

test('Claude Code gets --max-turns; Codex, Cursor and Grok have no such flag and get nothing', () => {
  const limits: PassLimits = { maxTurns: 30 };
  const claude = claudeReviewer.buildArgs('p', 'opus', '/tmp/c', limits);
  assert.equal(claude[claude.indexOf('--max-turns') + 1], '30');
  assert.ok(!claudeReviewer.buildArgs('p', 'opus', '/tmp/c').includes('--max-turns'));
  for (const r of [codexReviewer, cursorReviewer, grokReviewer]) {
    assert.deepEqual(r.buildArgs('p', 'm', '/tmp/c', limits), r.buildArgs('p', 'm', '/tmp/c'), r.name);
  }
  assert.equal(config.LENS_MAX_TURNS, 30);
  assert.equal(config.SYNTHESIS_MAX_TURNS, 45);
});

// --- the runner: caps per pass, usage per pass ------------------------------------------

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'crt-usage-'));
test.after(() => {
  for (const pgid of liveReviewerGroups()) {
    try { process.kill(-pgid, 'SIGKILL'); } catch { /* gone */ }
  }
  fs.rmSync(root, { recursive: true, force: true });
});

const checkout: CheckoutResult = {
  dir: root, headSha: 'h'.repeat(40), baseSha: 'b'.repeat(40), filesChanged: 0, additions: 0, deletions: 0,
  changedFiles: [], changedFileList: [],
};
const review: RunnableReview = {
  id: 1, repo: 'test-repo', branch: 'feat/x', reviewer: 'claude', model: 'fake',
  ticket_key: null, ticket_title: null, ticket_url: null, ticket_body: null,
};
const synthesis = {
  summary: 's', requirements: [], findings: [], observations: [], verdict: 'approve', can_merge: true, conclusion: 'c',
};

/**
 * Each process prints one Anthropic-style result line: the answer, plus usage
 * of 1000 cache reads and 10 output tokens. The lens named in CAPPED stops at
 * its turn cap instead. The argv records the cap it was given.
 */
function fakeReviewer(capped: string): { reviewer: ReviewerDefinition; caps: { prompt: string; maxTurns: number | undefined }[] } {
  const caps: { prompt: string; maxTurns: number | undefined }[] = [];
  const usage = { input_tokens: 0, cache_read_input_tokens: 1_000, cache_creation_input_tokens: 0, output_tokens: 10 };
  const script = `
case "$1" in
  *"Your job: synthesis"*) printf '%s\\n' "$SYNTH" ;;
  *"Your lens: $CAPPED"*) printf '%s\\n' "$CAP" ;;
  *) printf '%s\\n' "$LENS" ;;
esac
`;
  const line = (result: string) => JSON.stringify({ type: 'result', subtype: 'success', result, usage, total_cost_usd: 0.01 });
  const reviewer: ReviewerDefinition = {
    name: 'claude', label: 'Fake', defaultModel: 'fake', defaultModelEnv: 'REVIEW_MODEL', bin: '/bin/sh',
    buildArgs: (prompt, _model, _dir, limits) => {
      caps.push({ prompt, maxTurns: limits?.maxTurns });
      return ['-c', script, 'sh', prompt];
    },
    buildChildEnv: () => ({
      PATH: process.env.PATH,
      CAPPED: capped,
      SYNTH: line(JSON.stringify(synthesis)),
      LENS: line('{"findings":[],"observations":[]}'),
      CAP: JSON.stringify({ type: 'result', subtype: 'error_max_turns', is_error: true, usage, terminal_reason: 'max_turns' }),
    }),
    parseStreamLine: parseAnthropicStreamLine,
    discoverModels: async () => ({ models: [], source: null, fetchedAt: Date.now(), hint: null }),
    isAvailable: () => true,
    describeFailure: () => null,
  };
  return { reviewer, caps };
}

test('lenses run with the lens cap and synthesis with the synthesis cap; usage is kept per pass', async () => {
  const { reviewer, caps } = fakeReviewer('security');
  const logs: string[] = [];
  const meter = new UsageMeter(DEFAULT_USAGE_WEIGHTS);
  const out = await runReview(review, checkout, null, (_l, m) => logs.push(m), {
    reviewerDefinition: reviewer, timeoutMs: 30_000, rules: { text: '', files: [] }, checksConfig: null, usage: meter,
  });

  const synthesisCaps = caps.filter((c) => c.prompt.includes('Your job: synthesis')).map((c) => c.maxTurns);
  const lensCaps = caps.filter((c) => !c.prompt.includes('Your job: synthesis')).map((c) => c.maxTurns);
  assert.deepEqual(synthesisCaps, [config.SYNTHESIS_MAX_TURNS]);
  assert.deepEqual(lensCaps, Array(5).fill(config.LENS_MAX_TURNS));

  // The capped lens failed like any failed pass, with no corrective retry, and the review went on.
  const security = out.lensResults.find((r) => r.lens === 'security')!;
  assert.equal(security.output, null);
  assert.match(security.error!, /turn cap reached \(30 turns\)/);
  assert.ok(logs.some((l) => /^lens security: failed .*turn cap reached/.test(l)), logs.join('\n'));
  assert.ok(logs.includes('lens correctness: 0 findings, 0 observations (1k read, 0 written, 10 out)'), logs.join('\n'));
  assert.ok(logs.some((l) => /^synthesis: 0 findings, 0 observations, 0 requirements \(1k read, 0 written, 10 out\)$/.test(l)));

  // Every process counted, the failed one included.
  assert.deepEqual(out.usage.passes.map((p) => p.name).sort(), [
    'lens:contracts', 'lens:correctness', 'lens:regressions', 'lens:security', 'lens:tests', 'synthesis',
  ]);
  assert.equal(out.usage.totals.processes, 6);
  assert.equal(out.usage.totals.cache_read, 6_000);
  assert.equal(out.usage.totals.output, 60);
  assert.equal(out.usage.totals.weighted, 6 * (100 + 50));
  assert.equal(out.usage.passes.find((p) => p.name === 'synthesis')!.usage!.cost_usd, 0.01);
  assert.deepEqual(meter.summary(), out.usage);
});

test('a pass whose process never started is not recorded; a started one is, even when it fails', async () => {
  const { reviewer } = fakeReviewer('none');
  const meter = new UsageMeter(DEFAULT_USAGE_WEIGHTS);
  const base = { reviewer, model: 'fake', dir: root, timeoutMs: 5_000, usage: meter, pass: 'lens:never' };
  const aborted = new AbortController();
  aborted.abort();
  await assert.rejects(spawnReviewer('p', { ...base, signal: aborted.signal }, noLog), /cancelled/);
  assert.equal(meter.empty, true);

  const failing: ReviewerDefinition = { ...reviewer, buildArgs: () => ['-c', 'exit 3'] };
  await assert.rejects(spawnReviewer('p', { ...base, reviewer: failing, pass: 'lens:ran', signal: undefined }, noLog));
  assert.equal(meter.summary().passes.find((p) => p.name === 'lens:ran')?.processes, 1);
  assert.equal(meter.summary().passes.some((p) => p.name === 'lens:never'), false);
});
