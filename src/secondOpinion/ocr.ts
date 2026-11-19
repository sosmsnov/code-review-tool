import fs from 'node:fs';
import { config } from '../config.js';
import { buildBaseChildEnv, describeAuthFailure, isBinOnPath } from '../reviewers/shared.js';
import type {
  SecondOpinionComment, SecondOpinionInput, SecondOpinionProvider, SecondOpinionResult, SecondOpinionTokens,
} from './types.js';

/**
 * Open Code Review (`ocr`). Its provider, model and credentials come from its
 * own user config; this tool passes none of them.
 */
export function createOcrProvider(bin: string = config.OCR_BIN): SecondOpinionProvider {
  return {
    name: 'ocr',
    label: 'Open Code Review',
    bin,
    isAvailable: () => isBinOnPath(bin),
    describeFailure: (stderrTail, exitCode) =>
      describeAuthFailure(stderrTail, bin)
        ? `${bin} could not authenticate with its LLM provider; check the provider in its own config (exit code ${exitCode ?? 'null'})`
        : `${bin} exited with code ${exitCode ?? 'null'}`,
    buildArgs: buildOcrArgs,
    buildChildEnv: () => buildBaseChildEnv(),
    parseOutput: (outputFile) => parseOcrOutput(fs.readFileSync(outputFile, 'utf8')),
    forwardLogLine: forwardOcrLine,
  };
}

export function buildOcrArgs(input: SecondOpinionInput): string[] {
  return [
    'review',
    '--repo', input.dir,
    '--from', input.baseSha,
    '--to', input.headSha,
    '--format', 'json',
    '--output', input.outputFile,
    '--audience', 'human',
    '--color', 'never',
    '--concurrency', String(input.concurrency),
    '--timeout', String(input.timeoutMinutes),
    '--max-tokens-budget', String(input.tokenBudget),
    '--rule', input.ruleFile,
    '--background-file', input.backgroundFile,
  ];
}

/** `[ocr] ...` progress becomes log text; the per-tool-call lines (`▶`, `✔`) are dropped. */
export function forwardOcrLine(line: string): string | null {
  const text = line.replace(/^\s*\[ocr\]/, '').trim();
  if (!text) return null;
  if (/^[▶✔]/.test(text)) return null;
  return text;
}

type Json = Record<string, unknown>;

function obj(value: unknown): Json {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Json) : {};
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function int(value: unknown): number | undefined {
  const n = typeof value === 'string' && value.trim() ? Number(value) : value;
  return typeof n === 'number' && Number.isFinite(n) ? Math.trunc(n) : undefined;
}

/** `3m12s`, `1h2m`, `45s`, `1.5s` -> milliseconds; undefined when it is none of those. */
export function parseElapsed(text: string | undefined): number | undefined {
  if (!text) return undefined;
  const match = /^\s*(?:(\d+)h)?\s*(?:(\d+)m(?!s))?\s*(?:([\d.]+)s)?\s*$/.exec(text);
  if (!match || !match.slice(1).some(Boolean)) return undefined;
  const [, h, m, s] = match;
  const ms = Math.round(((Number(h ?? 0) * 60 + Number(m ?? 0)) * 60 + Number(s ?? 0)) * 1000);
  return Number.isFinite(ms) ? ms : undefined;
}

function parseComment(value: unknown): SecondOpinionComment | null {
  const c = obj(value);
  const content = str(c.content)?.trim();
  if (!content) return null;
  const start = int(c.start_line);
  const startLine = start && start > 0 ? start : 1;
  const end = int(c.end_line);
  const comment: SecondOpinionComment = {
    path: str(c.path)?.trim() ?? '',
    start_line: startLine,
    end_line: end && end >= startLine ? end : startLine,
    severity: str(c.severity)?.trim().toLowerCase() || 'unknown',
    category: str(c.category)?.trim().toLowerCase() || 'other',
    content,
  };
  const existing = str(c.existing_code);
  const suggestion = str(c.suggestion_code);
  if (existing?.trim()) comment.existing_code = existing;
  if (suggestion?.trim()) comment.suggestion_code = suggestion;
  return comment;
}

/**
 * The JSON `ocr review --format json` writes. Lenient: unknown severities and
 * categories are kept as given, missing lines are 1, a missing comment list is
 * empty. Throws only when the text is not a JSON object.
 */
export function parseOcrOutput(text: string): SecondOpinionResult {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    throw new Error(`the output is not valid JSON: ${(err as Error).message}`);
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('the output is not a JSON object');
  const root = raw as Json;
  const summary = obj(root.summary);
  const manifest = obj(root.manifest);
  const coverage = obj(manifest.coverage);
  const comments = (Array.isArray(root.comments) ? root.comments : [])
    .map(parseComment)
    .filter((c): c is SecondOpinionComment => c !== null);

  const total = int(summary.total_tokens);
  const input = int(summary.input_tokens);
  const output = int(summary.output_tokens);
  const cacheRead = int(summary.cache_read_tokens);
  const cacheWrite = int(summary.cache_write_tokens);
  const tokens: SecondOpinionTokens | undefined = total !== undefined || input !== undefined || output !== undefined
    ? { total: total ?? (input ?? 0) + (output ?? 0), input: input ?? 0, output: output ?? 0 }
    : undefined;
  if (tokens && cacheRead !== undefined) tokens.cache_read = cacheRead;
  if (tokens && cacheWrite !== undefined) tokens.cache_write = cacheWrite;
  const status = str(root.status);
  const failed = Array.isArray(coverage.failed) ? coverage.failed.length : 0;

  const result: SecondOpinionResult = { comments, raw, partial: failed > 0 || (status !== undefined && status !== 'complete') };
  const files = int(summary.files_reviewed);
  if (files !== undefined) result.files_reviewed = files;
  if (tokens) result.tokens = tokens;
  const elapsed = int(manifest.elapsed_ms) ?? parseElapsed(str(summary.elapsed));
  if (elapsed !== undefined) result.elapsed_ms = elapsed;
  const model = str(obj(root.llm).model);
  if (model) result.model = model;
  if (status) result.provider_status = status;
  return result;
}
