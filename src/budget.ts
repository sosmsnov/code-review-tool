import { config } from './config.js';
import { db } from './db.js';
import { parseRunUsage } from './usage.js';

/** `GET /api/usage`: the weighted tokens spent in the subscription window. */
export interface UsageWindow {
  window_hours: number;
  /** 0: the guard is off. */
  budget: number;
  used: number;
  /** Null while the guard is off. */
  remaining: number | null;
  reviews: number;
  coverage_passes: number;
  since: string;
}

/**
 * Reviews and coverage passes that finished in the window, plus the running
 * ones at their stored usage, which is written only when a run ends (so 0).
 */
export function usageWindow(now = Date.now(), opts: { budget?: number; windowHours?: number } = {}): UsageWindow {
  const windowHours = opts.windowHours ?? config.USAGE_WINDOW_HOURS;
  const budget = opts.budget ?? config.USAGE_BUDGET_WEIGHTED;
  const since = new Date(now - windowHours * 3_600_000).toISOString();
  const reviews = db
    .prepare<[string], { usage: string | null }>(
      `SELECT usage FROM reviews WHERE finished_at >= ? OR status IN ('queued', 'fetching', 'reviewing')`,
    )
    .all(since);
  const passes = db
    .prepare<[string], { usage: string | null }>(`SELECT usage FROM ticket_coverage WHERE finished_at >= ? OR status = 'running'`)
    .all(since);
  const used = [...reviews, ...passes].reduce((n, r) => n + (parseRunUsage(r.usage)?.totals.weighted ?? 0), 0);
  return {
    window_hours: windowHours,
    budget,
    used,
    remaining: budget > 0 ? Math.max(0, budget - used) : null,
    reviews: reviews.length,
    coverage_passes: passes.length,
    since,
  };
}

/** The 409 body when the window's budget is spent; null when a run may start. */
export function budgetRefusal(
  ignoreBudget: boolean | undefined,
  window: () => UsageWindow = () => usageWindow(),
): { error: string; usage: UsageWindow } | null {
  if (ignoreBudget) return null;
  const usage = window();
  if (usage.budget <= 0 || usage.used < usage.budget) return null;
  return {
    error:
      `The usage budget of the last ${usage.window_hours} h is spent (${usage.used} of ${usage.budget} weighted tokens). ` +
      'Wait for the window to move on, or start anyway with ignoreBudget.',
    usage,
  };
}
