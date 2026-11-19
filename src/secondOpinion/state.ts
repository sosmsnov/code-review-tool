import { ASSESSMENT_VERDICTS, isSecondOpinionName } from './types.js';
import type { AssessmentCounts, SecondOpinionName, SecondOpinionState } from './types.js';

export function emptyCounts(): AssessmentCounts {
  return Object.fromEntries(ASSESSMENT_VERDICTS.map((v) => [v, 0])) as AssessmentCounts;
}

/** The state stored when a run is created with a second opinion. */
export function pendingState(provider: SecondOpinionName, now: string = new Date().toISOString()): SecondOpinionState {
  return {
    provider,
    status: 'pending',
    requested_at: now,
    started_at: null,
    finished_at: null,
    elapsed_ms: null,
    model: null,
    tokens: null,
    files_reviewed: null,
    partial: false,
    comments_total: 0,
    counts: emptyCounts(),
    comments: [],
    conclusion: null,
    primary_verdict: null,
    primary_can_merge: null,
    error: null,
  };
}

/** `reviews.second_opinion` parsed; null when absent or unreadable. Missing fields get their empty values. */
export function parseSecondOpinionState(json: string | null | undefined): SecondOpinionState | null {
  if (!json) return null;
  try {
    const value = JSON.parse(json) as Partial<SecondOpinionState> | null;
    if (!value || typeof value !== 'object' || !isSecondOpinionName(value.provider)) return null;
    const base = pendingState(value.provider, value.requested_at ?? '');
    return {
      ...base,
      ...value,
      requested_at: value.requested_at ?? null,
      counts: { ...base.counts, ...(value.counts ?? {}) },
      comments: Array.isArray(value.comments) ? value.comments : [],
    };
  } catch {
    return null;
  }
}

/** The stored JSON, or the object an API already parsed it into. */
export function toSecondOpinionState(value: unknown): SecondOpinionState | null {
  if (value === null || value === undefined) return null;
  return parseSecondOpinionState(typeof value === 'string' ? value : JSON.stringify(value));
}

/** The second opinion in the fewest fields: for lists, MCP and logs. */
export function summarizeSecondOpinion(state: SecondOpinionState | null) {
  if (!state) return null;
  return {
    provider: state.provider,
    status: state.status,
    comments_total: state.comments_total,
    counts: state.counts,
    primary_verdict: state.primary_verdict,
    elapsed_ms: state.elapsed_ms,
    tokens_total: state.tokens?.total ?? null,
    error: state.error,
  };
}

export type SecondOpinionSummary = NonNullable<ReturnType<typeof summarizeSecondOpinion>>;

/**
 * A stage that never got to finish because its review ended first (failed,
 * cancelled, interrupted): `pending` becomes `skipped`, `running` becomes
 * `failed`. Null when there is nothing to change.
 */
export function closeOpenState(
  state: SecondOpinionState | null,
  reason: string,
  now: string = new Date().toISOString(),
): SecondOpinionState | null {
  if (!state || (state.status !== 'pending' && state.status !== 'running')) return null;
  return {
    ...state,
    status: state.status === 'pending' ? 'skipped' : 'failed',
    finished_at: now,
    error: state.error ?? reason,
  };
}
