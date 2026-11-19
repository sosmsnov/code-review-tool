import type { Review, ReviewStatus } from './types';

const ACTIVE: ReadonlySet<ReviewStatus> = new Set(['queued', 'fetching', 'reviewing']);

export function isActive(status: ReviewStatus): boolean {
  return ACTIVE.has(status);
}

/** Where a run has no value: still coming while it runs, absent once it ended without one. */
function missing(status: ReviewStatus): string {
  return isActive(status) ? 'pending' : '—';
}

type RunFields = Pick<
  Review,
  'status' | 'head_sha' | 'files_changed' | 'additions' | 'deletions' | 'requirements_met' | 'requirements_total'
>;

/** The placeholder for the head / base pair, or null once the checkout recorded it. */
export function shaPair(r: RunFields): string | null {
  return r.head_sha ? null : missing(r.status);
}

/** The diff counts once the checkout recorded them, else a placeholder. */
export function diffCounts(r: RunFields): { files: number; additions: number; deletions: number } | string {
  if (r.files_changed === null || r.files_changed === undefined) return missing(r.status);
  return { files: r.files_changed, additions: r.additions ?? 0, deletions: r.deletions ?? 0 };
}

export function requirementsCount(r: RunFields): string {
  if (r.requirements_total === null || r.requirements_total === undefined) return missing(r.status);
  return `${r.requirements_met ?? 0}/${r.requirements_total} met`;
}

const EMPTY: Record<'findings' | 'requirements', Record<'done' | 'active' | 'ended', string>> = {
  findings: {
    done: 'No issues found.',
    active: 'Findings appear once the review finishes.',
    ended: 'No findings were recorded for this run.',
  },
  requirements: {
    done: 'No requirements recorded.',
    active: 'Requirements are checked once the review finishes.',
    ended: 'No requirements were recorded for this run.',
  },
};

/** What an empty list says: only a finished review can report that it found nothing. */
export function emptyNote(what: 'findings' | 'requirements', status: ReviewStatus): string {
  return EMPTY[what][status === 'done' ? 'done' : isActive(status) ? 'active' : 'ended'];
}

/** A card title with its count; a run in progress has nothing to count yet. */
export function cardCount(label: string, count: number, status: ReviewStatus): string {
  return isActive(status) ? label : `${label} (${count})`;
}

/** The lens passes the runner is expected to emit progress for, in display order. */
const LENSES = ['correctness', 'security', 'tests', 'contracts', 'regressions'] as const;

/** `skipped`: a stage that did not run (an uninstalled provider); its note says why. */
export type LensState = 'pending' | 'running' | 'done' | 'failed' | 'skipped';
export interface LensProgress {
  name: string;
  state: LensState;
  note: string;
}

// Run-log lines such as `lens correctness: started` or `lens correctness: 2 findings, 1 observation`.
const LENS_RE = /^\s*lens\s+([a-z][\w-]*)\s*:\s*(.+?)\s*$/i;
// `second opinion ocr: started`, `second opinion ocr: 7 comments, ...`; the provider's own
// progress (`second opinion: ...`) names no provider and is not a stage line.
const SECOND_OPINION_RE = /^\s*second opinion\s+([a-z][\w-]*)\s*:\s*(.+?)\s*$/i;
const CONCLUSION_RE = /^\s*conclusion\s*:\s*(.+?)\s*$/i;

export const SECOND_OPINION_CHIP = 'second opinion';
export const CONCLUSION_CHIP = 'conclusion';

function stageState(rest: string): { state: LensState; note: string } {
  const lower = rest.toLowerCase();
  if (lower.startsWith('start')) return { state: 'running', note: '' };
  if (lower.startsWith('skip')) return { state: 'skipped', note: rest };
  if (lower.includes('fail') || lower.includes('error')) return { state: 'failed', note: rest };
  return { state: 'done', note: rest };
}

/**
 * Best-effort read of per-lens progress out of the run log, plus the second
 * opinion and its conclusion. Returns null when the log carries no recognisable
 * lens lines, so the caller can fall back to the raw log. `expectSecondOpinion`:
 * the run has a second opinion still to come, so its chips show as pending.
 */
export function deriveLensProgress(logs: readonly { message?: string | null }[], expectSecondOpinion = false): LensProgress[] | null {
  const seen = new Map<string, { state: LensState; note: string }>();
  const stages = new Map<string, { state: LensState; note: string }>();
  for (const line of logs) {
    const message = String(line?.message ?? '');
    const lens = LENS_RE.exec(message);
    if (lens) {
      seen.set(lens[1]!.toLowerCase(), stageState(lens[2]!));
      continue;
    }
    const second = SECOND_OPINION_RE.exec(message);
    if (second) {
      stages.set(SECOND_OPINION_CHIP, stageState(second[2]!));
      continue;
    }
    const conclusion = CONCLUSION_RE.exec(message);
    if (conclusion) stages.set(CONCLUSION_CHIP, stageState(conclusion[1]!));
  }
  if (seen.size === 0) return null;

  const known: LensProgress[] = LENSES.map((name) => ({
    name,
    state: seen.get(name)?.state ?? 'pending',
    note: seen.get(name)?.note ?? '',
  }));
  // An unexpected lens name still deserves a chip rather than being dropped.
  const extra: LensProgress[] = [...seen.entries()]
    .filter(([name]) => !(LENSES as readonly string[]).includes(name))
    .map(([name, v]) => ({ name, ...v }));

  const after: LensProgress[] = [];
  const second = stages.get(SECOND_OPINION_CHIP);
  if (second || expectSecondOpinion) after.push({ name: SECOND_OPINION_CHIP, ...(second ?? { state: 'pending', note: '' }) });
  const conclusion = stages.get(CONCLUSION_CHIP);
  // No comments, no conclusion pass; a failed or skipped provider has none either.
  const noConclusion = second && (second.state === 'failed' || second.state === 'skipped' || /^0 comments/i.test(second.note));
  if (conclusion) after.push({ name: CONCLUSION_CHIP, ...conclusion });
  else if ((second || expectSecondOpinion) && !noConclusion) after.push({ name: CONCLUSION_CHIP, state: 'pending', note: '' });
  return [...known, ...extra, ...after];
}
