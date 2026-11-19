import { formatTokens } from './secondOpinion/format.js';

/** What one reviewer process reported spending; summed when a pass runs more than one. */
export interface PassUsage {
  input: number;
  cache_read: number;
  cache_write: number;
  output: number;
  cost_usd: number | null;
  model: string | null;
}

export interface UsageWeights {
  input: number;
  cache_write: number;
  cache_read: number;
  output: number;
}

export const DEFAULT_USAGE_WEIGHTS: UsageWeights = Object.freeze({ input: 1, cache_write: 1.25, cache_read: 0.1, output: 5 });

/** One pass of a review (`lens:security`, `synthesis`, ...), every process it started included. */
export interface UsagePass {
  name: string;
  /** Null when none of its processes reported usage. */
  usage: PassUsage | null;
  weighted: number;
  processes: number;
}

export interface UsageTotals {
  input: number;
  cache_read: number;
  cache_write: number;
  output: number;
  /** Null when no process reported a cost. */
  cost_usd: number | null;
  weighted: number;
  processes: number;
}

/** `reviews.usage` and `ticket_coverage.usage`. */
export interface RunUsage {
  passes: UsagePass[];
  totals: UsageTotals;
}

/**
 * `input=1,cache_write=1.25,cache_read=0.1,output=5`; keys left out keep
 * their default. Throws on an unknown key or a value that is not a
 * non-negative number.
 */
export function parseUsageWeights(text: string | undefined): UsageWeights {
  const weights: UsageWeights = { ...DEFAULT_USAGE_WEIGHTS };
  if (!text?.trim()) return weights;
  for (const part of text.split(',')) {
    if (!part.trim()) continue;
    const [rawKey, rawValue, ...rest] = part.split('=');
    const key = rawKey?.trim() ?? '';
    const value = Number(rawValue?.trim());
    if (rest.length || !(key in DEFAULT_USAGE_WEIGHTS)) {
      throw new Error(`unknown weight "${part.trim()}" (keys: ${Object.keys(DEFAULT_USAGE_WEIGHTS).join(', ')})`);
    }
    if (!rawValue?.trim() || !Number.isFinite(value) || value < 0) throw new Error(`weight "${part.trim()}" is not a non-negative number`);
    weights[key as keyof UsageWeights] = value;
  }
  return weights;
}

export function weightedTokens(u: PassUsage | null, weights: UsageWeights): number {
  if (!u) return 0;
  return Math.round(
    u.input * weights.input + u.cache_write * weights.cache_write + u.cache_read * weights.cache_read + u.output * weights.output,
  );
}

export function addUsage(a: PassUsage | null, b: PassUsage | null): PassUsage | null {
  if (!a) return b ? { ...b } : null;
  if (!b) return a;
  return {
    input: a.input + b.input,
    cache_read: a.cache_read + b.cache_read,
    cache_write: a.cache_write + b.cache_write,
    output: a.output + b.output,
    cost_usd: a.cost_usd === null && b.cost_usd === null ? null : (a.cost_usd ?? 0) + (b.cost_usd ?? 0),
    model: a.model ?? b.model,
  };
}

function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
}

/**
 * The `usage` of an Anthropic-style `result` event (Claude Code, Cursor
 * Agent, Grok CLI); null when the event has none. The model is the event's
 * own, else the `modelUsage` entry that cost the most.
 */
export function usageFromResultEvent(e: Record<string, any>): PassUsage | null {
  const u = e.usage;
  if (typeof u !== 'object' || u === null) return null;
  let model: string | null = typeof e.model === 'string' && e.model ? e.model : null;
  if (!model && typeof e.modelUsage === 'object' && e.modelUsage !== null) {
    const entries = Object.entries(e.modelUsage as Record<string, any>);
    entries.sort((x, y) => num(y[1]?.costUSD) - num(x[1]?.costUSD));
    model = entries[0]?.[0] ?? null;
  }
  return {
    input: num(u.input_tokens),
    cache_read: num(u.cache_read_input_tokens),
    cache_write: num(u.cache_creation_input_tokens),
    output: num(u.output_tokens),
    cost_usd: typeof e.total_cost_usd === 'number' && Number.isFinite(e.total_cost_usd) ? e.total_cost_usd : null,
    model,
  };
}

/**
 * The `usage` of a Codex `turn.completed` event. Codex counts cached tokens
 * inside `input_tokens`, so they are taken out of `input`.
 */
export function usageFromCodexTurn(e: Record<string, any>): PassUsage | null {
  const u = e.usage;
  if (typeof u !== 'object' || u === null) return null;
  const cached = num(u.cached_input_tokens);
  return {
    input: Math.max(0, num(u.input_tokens) - cached),
    cache_read: cached,
    cache_write: num(u.cache_write_input_tokens),
    output: num(u.output_tokens),
    cost_usd: null,
    model: null,
  };
}

/** Collects the usage of every process of a run, by pass name, in first-seen order. */
export class UsageMeter {
  private readonly passes = new Map<string, { usage: PassUsage | null; processes: number }>();

  constructor(private readonly weights: UsageWeights) {}

  record(name: string, usage: PassUsage | null): void {
    const entry = this.passes.get(name) ?? { usage: null, processes: 0 };
    entry.usage = addUsage(entry.usage, usage);
    entry.processes += 1;
    this.passes.set(name, entry);
  }

  /** One pass's usage so far; null when it reported none. */
  pass(name: string): PassUsage | null {
    return this.passes.get(name)?.usage ?? null;
  }

  get empty(): boolean {
    return this.passes.size === 0;
  }

  summary(): RunUsage {
    const passes: UsagePass[] = [...this.passes].map(([name, p]) => ({
      name,
      usage: p.usage,
      weighted: weightedTokens(p.usage, this.weights),
      processes: p.processes,
    }));
    return { passes, totals: totalsOf(passes) };
  }
}

export function totalsOf(passes: readonly UsagePass[]): UsageTotals {
  const sum = passes.reduce<PassUsage | null>((acc, p) => addUsage(acc, p.usage), null);
  return {
    input: sum?.input ?? 0,
    cache_read: sum?.cache_read ?? 0,
    cache_write: sum?.cache_write ?? 0,
    output: sum?.output ?? 0,
    cost_usd: sum?.cost_usd ?? null,
    weighted: passes.reduce((n, p) => n + p.weighted, 0),
    processes: passes.reduce((n, p) => n + p.processes, 0),
  };
}

/** Totals of several runs (a ticket's branches plus its coverage pass). */
export function sumTotals(list: readonly (UsageTotals | null | undefined)[]): UsageTotals {
  const out: UsageTotals = { input: 0, cache_read: 0, cache_write: 0, output: 0, cost_usd: null, weighted: 0, processes: 0 };
  for (const t of list) {
    if (!t) continue;
    out.input += t.input;
    out.cache_read += t.cache_read;
    out.cache_write += t.cache_write;
    out.output += t.output;
    out.weighted += t.weighted;
    out.processes += t.processes;
    if (t.cost_usd !== null) out.cost_usd = (out.cost_usd ?? 0) + t.cost_usd;
  }
  return out;
}

/** A stored `usage` column, or null when it is empty or unreadable. */
export function parseRunUsage(json: string | null | undefined): RunUsage | null {
  if (!json) return null;
  try {
    const value = JSON.parse(json) as RunUsage;
    return value && typeof value === 'object' && value.totals && Array.isArray(value.passes) ? value : null;
  } catch {
    return null;
  }
}

/** `1.2M read, 90k written, 8k out`. "Read" is every prompt token not written to the cache: uncached input plus cache reads. */
export function usageParts(u: Pick<PassUsage, 'input' | 'cache_read' | 'cache_write' | 'output'>): string {
  return `${formatTokens(u.input + u.cache_read)} read, ${formatTokens(u.cache_write)} written, ${formatTokens(u.output)} out`;
}

/** ` (1.2M read, 90k written, 8k out)` after a pass's log line; empty without usage. */
export function passUsageSuffix(u: PassUsage | null): string {
  return u ? ` (${usageParts(u)})` : '';
}

/** `9.4M read, 0.8M written, 110k out, weighted 2.1M, 8 processes`. */
export function usageTotalsLine(t: UsageTotals): string {
  return `${usageParts(t)}, weighted ${formatTokens(t.weighted)}, ${t.processes} process${t.processes === 1 ? '' : 'es'}`;
}
