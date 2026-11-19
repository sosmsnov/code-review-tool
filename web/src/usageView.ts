import type { UsageNumbers, UsageTotals, UsageWindow } from './types';

/** `245k`, `1.2M`, `950`: the server's token format. */
export function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`;
  return String(n);
}

/** `1.2M read, 90k written, 8k out`; "read" is uncached input plus cache reads. */
export function usageParts(u: UsageNumbers): string {
  return `${fmtTokens(u.input + u.cache_read)} read, ${fmtTokens(u.cache_write)} written, ${fmtTokens(u.output)} out`;
}

/** `9.4M read, 800k written, 110k out, weighted 2.1M, 8 processes`. */
export function usageTotalsLine(t: UsageTotals): string {
  return `${usageParts(t)}, weighted ${fmtTokens(t.weighted)}, ${t.processes} process${t.processes === 1 ? '' : 'es'}`;
}

/** `1.2M / 5M weighted in the last 5 h`, or the spend alone when no budget is set. */
export function usageWindowLine(w: UsageWindow): string {
  const span = `in the last ${w.window_hours} h`;
  return w.budget > 0
    ? `${fmtTokens(w.used)} / ${fmtTokens(w.budget)} weighted ${span}${w.used >= w.budget ? ' (budget spent)' : ''}`
    : `${fmtTokens(w.used)} weighted ${span} (no budget set)`;
}
