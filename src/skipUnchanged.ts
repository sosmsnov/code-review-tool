import { assertAllowedRemote, repoUrl } from './config.js';
import { db } from './db.js';
import { runInSandbox } from './gitSandbox.js';
import { assertSafeName } from './gitNames.js';
import { branchTip, localRepoPath } from './localRepos.js';
import type { ResolvedTarget, ReviewRow } from './types.js';

/** A branch of a ticket batch that was not queued: its head is the one its latest finished review saw. */
export interface SkippedTarget {
  repo: string;
  branch: string;
  head_sha: string;
  review_id: number;
  reason: string;
}

export type HeadLookup = (target: ResolvedTarget) => Promise<string | null>;

/** The commit a review of this target would check out now; null when it cannot be read. */
export async function targetHeadSha(target: ResolvedTarget): Promise<string | null> {
  try {
    assertSafeName('branch', target.branch);
    if (target.source === 'local') return await branchTip(await localRepoPath(target.repo), target.branch);
    const url = repoUrl(target.repo);
    assertAllowedRemote(url);
    const result = await runInSandbox(['git', 'ls-remote', url, `refs/heads/${target.branch}`], { timeoutMs: 60_000 });
    const line = result.stdout.split('\n').find((l) => l.trim().endsWith(`\trefs/heads/${target.branch}`));
    const sha = line?.split('\t')[0]?.trim() ?? '';
    return /^[0-9a-f]{40,64}$/.test(sha) ? sha : null;
  } catch {
    return null;
  }
}

/** The newest finished review of a branch in a ticket group. */
function latestDoneInGroup(groupKey: string, repo: string, branch: string): ReviewRow | undefined {
  return db
    .prepare<[string, string, string], ReviewRow>(
      `SELECT * FROM reviews WHERE group_key = ? AND repo = ? AND branch = ? AND status = 'done' ORDER BY id DESC LIMIT 1`,
    )
    .get(groupKey, repo, branch);
}

/**
 * Splits a ticket batch into the targets to review and the ones whose head
 * equals the head of their latest finished review in the group, diffed
 * against the same base branch. A target with uncommitted changes, or whose
 * head cannot be read, is always reviewed.
 */
export async function skipUnchanged(
  targets: readonly ResolvedTarget[],
  groupOf: (target: ResolvedTarget) => string | null,
  headOf: HeadLookup = targetHeadSha,
): Promise<{ run: ResolvedTarget[]; skipped: SkippedTarget[] }> {
  const decisions = await Promise.all(targets.map(async (target): Promise<SkippedTarget | null> => {
    const key = groupOf(target);
    if (!key || target.includeWorkingTree) return null;
    const last = latestDoneInGroup(key, target.repo, target.branch);
    if (!last?.head_sha || last.base_branch !== target.baseBranch) return null;
    const head = await headOf(target);
    if (!head || head !== last.head_sha) return null;
    return {
      repo: target.repo,
      branch: target.branch,
      head_sha: head,
      review_id: last.id,
      reason: `unchanged since review ${last.id}`,
    };
  }));
  const run: ResolvedTarget[] = [];
  const skipped: SkippedTarget[] = [];
  targets.forEach((target, i) => {
    const decision = decisions[i];
    if (decision) skipped.push(decision);
    else run.push(target);
  });
  return { run, skipped };
}
