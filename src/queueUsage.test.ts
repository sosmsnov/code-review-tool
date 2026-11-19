import './testEnv.js';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { ReviewerDefinition } from './reviewers/types.js';

/**
 * The usage a run spent is stored when the run fails or is cancelled, and the
 * budget window counts it. Same stand as the queue run test: a local clone, a
 * fake docker for the sandbox git, and a fake reviewer that reports usage.
 */
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'crt-queue-usage-'));
const clone = path.join(root, 'clone');
const bin = path.join(root, 'bin');
const prompts = path.join(root, 'prompts');
const rules = path.join(root, 'rules');
for (const dir of [clone, bin, prompts, rules]) fs.mkdirSync(dir, { recursive: true });

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid',
      GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid',
      GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
    },
  }).trim();
}
const lines = (n: number, tag: string) => Array.from({ length: n }, (_, i) => `${tag} ${i + 1}`).join('\n') + '\n';

git(clone, 'init', '-q', '-b', 'main');
fs.mkdirSync(path.join(clone, 'src/orders'), { recursive: true });
fs.writeFileSync(path.join(clone, 'src/orders/service.ts'), lines(50, 'service'));
git(clone, 'add', '-A');
git(clone, 'commit', '-q', '-m', 'base');
git(clone, 'checkout', '-q', '-b', 'feat/orders');
fs.writeFileSync(path.join(clone, 'src/orders/service.ts'), lines(60, 'service v2'));
git(clone, 'commit', '-q', '-am', 'branch');
git(clone, 'checkout', '-q', 'main');

// The fake docker runs each sandbox git command on the host, with /work and /src mapped to their mounts.
// Nothing reaches the network: a fetch from the GitHub remote fails, as offline.
const dockerScript = path.join(bin, 'fake-docker.mjs');
fs.writeFileSync(dockerScript, `
import { spawnSync } from 'node:child_process';
const args = process.argv.slice(2);
if (args[0] === 'image' && args[1] === 'inspect') process.exit(0);
let work = null, src = null, workdir = '/work', i = 1;
for (; i < args.length; i++) {
  const a = args[i];
  if (a === 'fake-git-image') { i++; break; }
  if (a === '-v') { work = args[++i].replace(/:\\/work$/, ''); continue; }
  if (a === '--mount') { src = /src=([^,]+)/.exec(args[++i])[1]; continue; }
  if (a === '-w') { workdir = args[++i]; continue; }
  if (['-e', '--user'].includes(a)) i++;
}
const map = (v) => v === '/work' || v.startsWith('/work/') ? work + v.slice(5)
  : v === '/src' || v.startsWith('/src/') ? src + v.slice(4) : v;
const cmd = args.slice(i).map(map);
if (cmd[0] !== 'git') { process.stderr.write('fake docker: unsupported ' + cmd.join(' ') + '\\n'); process.exit(1); }
if (cmd[1] === 'fetch' && cmd.includes('origin')) { process.stderr.write('fatal: offline\\n'); process.exit(128); }
const r = spawnSync('git', cmd.slice(1), {
  cwd: map(workdir), encoding: 'utf8',
  env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' },
});
process.stdout.write(r.stdout ?? '');
process.stderr.write(r.stderr ?? '');
process.exit(r.status ?? 1);
`);
const docker = path.join(bin, 'docker');
fs.writeFileSync(docker, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(dockerScript)} "$@"\n`, { mode: 0o755 });

Object.assign(process.env, {
  DATA_DIR: path.join(root, 'data'),
  ALLOWED_REPOS: 'test-repo',
  GITHUB_ORG: 'test-org',
  DOCKER_BIN: docker,
  GIT_IMAGE: 'fake-git-image',
  LOCAL_REPOS: `test-repo=${clone}`,
  LOCAL_REPOS_DIR: '',
  RULES_DIR: rules,
  SECOND_OPINION: 'none',
  REVIEW_CONCURRENCY: '1',
  LOG_LEVEL: 'error',
});

const store = await import('./db.js');
const { enqueueReview, cancelReview } = await import('./queue.js');
const { liveReviewerGroups } = await import('./reviewRunner.js');
const { setReviewerForTests } = await import('./reviewers/index.js');
const { parseAnthropicStreamLine } = await import('./reviewers/anthropicStream.js');
const { usageWindow } = await import('./budget.js');
const { parseRunUsage } = await import('./usage.js');

const usage = { input_tokens: 0, cache_read_input_tokens: 1_000, cache_creation_input_tokens: 0, output_tokens: 10 };
const line = (result: string) => JSON.stringify({ type: 'result', subtype: 'success', result, usage, total_cost_usd: 0.01 });
const SPENT_PER_PROCESS = 100 + 50;

// Lenses answer at once. Synthesis answers with garbage (the run fails) or, in
// the cancel scenario, hangs until the run is cancelled.
const script = `
printf '%s' "$1" > "$PROMPT_DIR/$$.txt"
case "$1" in
  *"Your job: synthesis"*) if [ -n "$HANG" ]; then sleep 60; else printf '%s\\n' "$BAD"; fi ;;
  *) printf '%s\\n' "$LENS" ;;
esac
`;
let hang = false;
const fakeReviewer: ReviewerDefinition = {
  name: 'claude', label: 'Fake reviewer', defaultModel: 'fake', defaultModelEnv: 'REVIEW_MODEL', bin: '/bin/sh',
  acceptsUnlistedModels: true,
  buildArgs: (prompt) => ['-c', script, 'sh', prompt],
  buildChildEnv: () => ({
    PATH: process.env.PATH, PROMPT_DIR: prompts, ...(hang ? { HANG: '1' } : {}),
    BAD: line('not json at all'), LENS: line('{"findings":[],"observations":[]}'),
  }),
  parseStreamLine: parseAnthropicStreamLine,
  discoverModels: async () => ({ models: [], source: null, fetchedAt: Date.now(), hint: null }),
  isAvailable: () => true,
  describeFailure: () => null,
};
setReviewerForTests('claude', fakeReviewer);

test.after(() => {
  for (const pgid of liveReviewerGroups()) {
    try { process.kill(-pgid, 'SIGKILL'); } catch { /* gone */ }
  }
  setReviewerForTests('claude', null);
  store.db.close();
  fs.rmSync(root, { recursive: true, force: true });
});

async function waitFor(done: () => boolean): Promise<void> {
  const deadline = Date.now() + 60_000;
  while (!done() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
}
const ended = (id: number) => ['done', 'failed', 'cancelled'].includes(store.getReview(id)!.status);
const queued = () => store.createReview({
  repo: 'test-repo', branch: 'feat/orders', base_branch: 'main', source: 'local', status: 'queued', reviewer: 'claude', model: 'fake',
});

test('a failed run keeps the usage it spent, and the window counts it', async () => {
  hang = false;
  const before = usageWindow().used;
  const row = queued();
  enqueueReview(row.id);
  await waitFor(() => ended(row.id));
  const review = store.getReview(row.id)!;
  const logs = store.getLogs(row.id).map((l) => l.message).join('\n');
  assert.equal(review.status, 'failed', logs);
  const spent = parseRunUsage(review.usage);
  assert.ok(spent, 'the usage column is set');
  assert.ok(spent.totals.weighted >= 6 * SPENT_PER_PROCESS, String(spent.totals.weighted));
  assert.equal(usageWindow().used - before, spent.totals.weighted);
});

test('a cancelled run keeps the usage it spent, and the window counts it', async () => {
  hang = true;
  for (const f of fs.readdirSync(prompts)) fs.rmSync(path.join(prompts, f));
  const before = usageWindow().used;
  const row = queued();
  enqueueReview(row.id);
  // Every lens has answered once synthesis has started.
  await waitFor(() => fs.readdirSync(prompts).some((f) => fs.readFileSync(path.join(prompts, f), 'utf8').includes('Your job: synthesis')));
  assert.equal(cancelReview(row.id), true);
  await waitFor(() => ended(row.id));
  const review = store.getReview(row.id)!;
  assert.equal(review.status, 'cancelled');
  const spent = parseRunUsage(review.usage);
  assert.ok(spent, 'the usage column is set');
  assert.equal(spent.totals.weighted, 5 * SPENT_PER_PROCESS);
  assert.equal(usageWindow().used - before, 5 * SPENT_PER_PROCESS);
});
