import type { AssessmentCounts } from './types.js';

/** `245k`, `1.2M`, `950`. */
export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`;
  return String(n);
}

/** `3m12s`, `45s`, `1h2m`. */
export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h) return `${h}h${m}m`;
  if (m) return `${m}m${s}s`;
  return `${s}s`;
}

/** `2 confirmed, 1 duplicate, 1 observation, 3 rejected` (and the unassessed ones, when there are any). */
export function countsLine(counts: AssessmentCounts): string {
  const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
  const parts = [
    `${counts.confirmed} confirmed`,
    plural(counts.duplicate, 'duplicate'),
    plural(counts.observation, 'observation'),
    `${counts.rejected} rejected`,
  ];
  if (counts.not_assessed) parts.push(`${counts.not_assessed} not assessed`);
  return parts.join(', ');
}
