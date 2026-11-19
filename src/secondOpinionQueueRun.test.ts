import './testEnv.js';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import type { ReviewerDefinition } from './reviewers/types.js';

/**
 * One review through the queue to `done` with a second opinion: a local
 * clone, a fake docker that runs the sandbox's git commands on the host, a
 * fake reviewer CLI, and a fake `ocr`. Checks what the queue stores.
 */
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'crt-so-queue-run-'));
const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
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

const fakeOcr = path.join(bin, 'fake-ocr');
fs.writeFileSync(fakeOcr, `#!/bin/sh
out=""
while [ $# -gt 0 ]; do
  if [ "$1" = "--output" ]; then out="$2"; fi
  shift
done
cat "${path.join(FIXTURES, 'ocr-review-stderr.txt')}" >&2
cp "${path.join(FIXTURES, 'ocr-review-output.json')}" "$out"
`, { mode: 0o755 });

// Everything explicit: a local .env must not leak in (dotenv never overrides a set variable).
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
const { enqueueReview } = await import('./queue.js');
const { liveReviewerGroups } = await import('./reviewRunner.js');
const { setReviewerForTests } = await import('./reviewers/index.js');
const { createOcrProvider } = await import('./secondOpinion/ocr.js');
const { setSecondOpinionProviderForTests } = await import('./secondOpinion/index.js');
const { parseSecondOpinionState, storedChoice } = await import('./secondOpinion/state.js');
const { rawOutputDir } = await import('./reportWriter.js');

const synthesis = {
  summary: 'Changes the order totals.',
  requirements: [{ text: 'Apply the discount', status: 'met', evidence: 'src/orders/service.ts:3' }],
  findings: [{ severity: 'minor', kind: 'diff', file: 'src/orders/service.ts', line: 5, lens: 'correctness', title: 'Primary finding', problem: 'p1' }],
  observations: [],
  verdict: 'approve',
  can_merge: true,
  conclusion: 'Fine.',
};
// Fixture comments by provider severity: 1 docs (high), 2 discount (medium), 3 test (low).
const conclusion = {
  assessments: [
    { comment: 1, verdict: 'rejected', reason: 'The doc is not part of the change.' },
    {
      comment: 2, verdict: 'confirmed', reason: 'Reproduced on line 42.',
      finding: {
        severity: 'major', category: 'correctness', kind: 'diff', file: 'src/orders/service.ts', line: 42,
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
  name: 'claude', label: 'Fake reviewer', defaultModel: 'fake', defaultModelEnv: 'REVIEW_MODEL', bin: '/bin/sh',
  acceptsUnlistedModels: true,
  buildArgs: (prompt) => ['-c', reviewerScript, 'sh', prompt],
  buildChildEnv: () => ({
    PATH: process.env.PATH, PROMPT_DIR: prompts, SYNTH_JSON: JSON.stringify(synthesis), CONCLUSION_JSON: JSON.stringify(conclusion),
  }),
  parseStreamLine: (line) => ({ result: line }),
  discoverModels: async () => ({ models: [], source: null, fetchedAt: Date.now(), hint: null }),
  isAvailable: () => true,
  describeFailure: () => null,
};
setReviewerForTests('claude', fakeReviewer);
setSecondOpinionProviderForTests('ocr', createOcrProvider(fakeOcr));

test.after(() => {
  for (const pgid of liveReviewerGroups()) {
    try { process.kill(-pgid, 'SIGKILL'); } catch { /* gone */ }
  }
  setReviewerForTests('claude', null);
  setSecondOpinionProviderForTests('ocr', null);
  store.db.close();
  fs.rmSync(root, { recursive: true, force: true });
});

test('a review with a second opinion runs through the queue to done and stores what the stage produced', async () => {
  const row = store.createReview({
    repo: 'test-repo', branch: 'feat/orders', base_branch: 'main', source: 'local', status: 'queued',
    reviewer: 'claude', model: 'fake', second_opinion: storedChoice('ocr'),
  });
  enqueueReview(row.id);
  const deadline = Date.now() + 60_000;
  let review = store.getReview(row.id)!;
  while (!['done', 'failed', 'cancelled'].includes(review.status) && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 50));
    review = store.getReview(row.id)!;
  }
  const logs = store.getLogs(row.id).map((l) => l.message);
  assert.equal(review.status, 'done', `${review.error ?? ''}\n${logs.join('\n')}`);
  assert.equal(review.verdict, 'changes_requested');

  const state = parseSecondOpinionState(review.second_opinion)!;
  assert.equal(state.status, 'done');
  assert.equal(state.primary_verdict, 'approve');
  assert.deepEqual(state.counts, { confirmed: 1, duplicate: 1, observation: 0, rejected: 1, not_assessed: 0 });
  assert.equal(state.conclusion, 'One real defect the review missed.');

  const findings = store.getFindings(row.id);
  assert.deepEqual(findings.map((f) => [f.title, f.lens, f.corroborated]), [
    ['Primary finding', 'correctness', 1],
    ['Discount applied twice', 'second_opinion', null],
  ]);

  const lenses = path.join(process.env.DATA_DIR!, rawOutputDir(review.report_path!));
  assert.equal(
    fs.readFileSync(path.join(lenses, 'second-opinion.json'), 'utf8'),
    fs.readFileSync(path.join(FIXTURES, 'ocr-review-output.json'), 'utf8'),
  );
  assert.ok(fs.existsSync(path.join(lenses, 'conclusion.json')));
  const report = fs.readFileSync(path.join(process.env.DATA_DIR!, review.report_path!), 'utf8');
  assert.match(report, /## Second opinion/);
  assert.equal(fs.existsSync(path.join(process.env.DATA_DIR!, 'second-opinion', String(row.id))), false);
  assert.ok(logs.includes('Checkout is unchanged \u2014 the review did not touch any file.'));
  assert.deepEqual(liveReviewerGroups(), []);
});
