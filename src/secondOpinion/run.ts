import fs from 'node:fs';
import path from 'node:path';
import { createAnchorContext } from '../anchors.js';
import { config } from '../config.js';
import { sanitizeLogMessage } from '../logSanitize.js';
import {
  anchorWithReanchor, checkoutChangedFiles, normalize, renderTicketScope, runPass, spawnTracked,
  type PassOptions, type PromptVars, type RunnableReview,
} from '../reviewRunner.js';
import type { CheckoutResult, OnLog, ReviewOutput, TicketInfo } from '../types.js';
import {
  buildConclusionPrompt, conclusionOutputSchema, MAX_ASSESSED_COMMENTS, mergeAssessments, NOTHING_FOUND, sortComments,
} from './conclusion.js';
import { countsLine, formatElapsed, formatTokens } from './format.js';
import { buildBackground, buildRuleFile } from './files.js';
import { secondOpinionNotInstalled } from './index.js';
import { pendingState } from './state.js';
import type { SecondOpinionProvider, SecondOpinionResult, SecondOpinionState } from './types.js';

export interface SecondOpinionRequest {
  provider: SecondOpinionProvider;
  /** When the run was created with it; kept in the state. */
  requestedAt?: string | null;
  /** Called with the state on every change, so the caller can store it. */
  onUpdate?: (state: SecondOpinionState) => void;
  /** The provider's working files; `<DATA_DIR>/second-opinion/<review id>` when absent. Removed afterwards. */
  workDir?: string;
  timeoutMs?: number;
  concurrency?: number;
  tokenBudget?: number;
  /** Pasted requirements or the ticket group's approved decisions, for the background file. */
  requirementsText?: string | null;
}

/** What is kept beside the report: the provider's files and output verbatim, and the conclusion answer. */
export interface SecondOpinionRaw {
  background?: string;
  rule?: string;
  output?: string;
  conclusion?: unknown;
  reanchor?: unknown;
}

export interface SecondOpinionContext {
  review: RunnableReview;
  checkout: CheckoutResult;
  ticket: TicketInfo | null;
  /** The primary result, normalised. Never changed here; only added to. */
  primary: ReviewOutput;
  vars: PromptVars;
  rulesText: string;
  slice: boolean;
  passOpts: PassOptions;
  onLog: OnLog;
  request: SecondOpinionRequest;
}

export interface SecondOpinionRun {
  /** The final review: the primary result plus what the second opinion added, normalised again. */
  output: ReviewOutput;
  state: SecondOpinionState;
  raw: SecondOpinionRaw;
}

const MAX_ERROR_TAIL = 1_000;

/** ocr's own `--timeout`: a minute below the process timeout, at least one minute. */
export function providerTimeoutMinutes(timeoutMs: number): number {
  return Math.max(1, Math.floor((timeoutMs - 60_000) / 60_000));
}

/** `7 comments, 9 files, 245k tokens, 3m12s`. */
export function providerLine(result: SecondOpinionResult, elapsedMs: number): string {
  const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
  const parts = [plural(result.comments.length, 'comment')];
  if (result.files_reviewed !== undefined) parts.push(plural(result.files_reviewed, 'file'));
  if (result.tokens) parts.push(`${formatTokens(result.tokens.total)} tokens`);
  parts.push(formatElapsed(elapsedMs));
  if (result.partial) parts.push('partial');
  return parts.join(', ');
}

function firstLine(text: string): string {
  return text.split('\n').map((l) => l.trim()).find(Boolean) ?? '';
}

/**
 * Stages 2 and 3 of a review: the provider reviews the same range on the same
 * checkout without seeing the primary result, then one pass of the review's own
 * reviewer checks every comment against the code. Confirmed comments become
 * findings and the verdict is normalised again over the merged list. A failure
 * of either stage leaves the primary result as it is; a cancel throws.
 */
export async function runSecondOpinion(ctx: SecondOpinionContext): Promise<SecondOpinionRun> {
  const { review, checkout, primary, request, onLog, passOpts } = ctx;
  const { provider } = request;
  const name = provider.name;
  const signal = passOpts.signal;
  const raw: SecondOpinionRaw = {};
  const now = () => new Date().toISOString();
  let state: SecondOpinionState = {
    ...pendingState(name, request.requestedAt ?? now()),
    primary_verdict: primary.verdict,
    primary_can_merge: primary.can_merge,
  };
  const update = (patch: Partial<SecondOpinionState>) => {
    state = { ...state, ...patch };
    try {
      request.onUpdate?.(state);
    } catch {
      // Bookkeeping must never break a review.
    }
  };
  const finish = (output: ReviewOutput): SecondOpinionRun => ({ output: { ...output, second_opinion: state }, state, raw });
  const fail = (stage: string, message: string): SecondOpinionRun => {
    onLog('warn', `${stage}: failed (${firstLine(message)})`);
    // Stored errors reach the API as JSON: no control characters, whichever branch failed.
    update({ status: 'failed', finished_at: now(), error: sanitizeLogMessage(message).slice(0, 2_000) });
    return finish(primary);
  };

  if (!provider.isAvailable()) {
    const message = secondOpinionNotInstalled(provider);
    onLog('warn', `second opinion ${name}: skipped (${message})`);
    update({ status: 'skipped', finished_at: now(), error: sanitizeLogMessage(message) });
    return finish(primary);
  }
  if (signal?.aborted) throw new Error('Review cancelled');

  update({ status: 'running', started_at: now() });
  const workDir = request.workDir ?? path.join(config.DATA_DIR, 'second-opinion', String(review.id));
  try {
    fs.rmSync(workDir, { recursive: true, force: true });
    fs.mkdirSync(workDir, { recursive: true });
    const backgroundFile = path.join(workDir, 'background.md');
    const ruleFile = path.join(workDir, 'rule.json');
    const outputFile = path.join(workDir, 'output.json');
    raw.background = buildBackground({
      ticketKey: ctx.ticket?.key || review.ticket_key,
      ticketTitle: ctx.ticket?.title || review.ticket_title,
      ticketBody: ctx.ticket?.body ?? review.ticket_body,
      comments: ctx.ticket?.comments ?? [],
      checklist: ctx.vars.checklist,
      requirementsText: request.requirementsText ?? null,
      ticketScope: renderTicketScope(ctx.vars.slice, review),
    });
    raw.rule = buildRuleFile(ctx.rulesText);
    fs.writeFileSync(backgroundFile, raw.background, 'utf8');
    fs.writeFileSync(ruleFile, raw.rule, 'utf8');

    const timeoutMs = request.timeoutMs ?? config.SECOND_OPINION_TIMEOUT_MS;
    onLog('info', `second opinion ${name}: started`);
    const providerStarted = Date.now();
    let result: SecondOpinionResult;
    try {
      const exit = await spawnTracked({
        bin: provider.bin,
        args: () => provider.buildArgs({
          dir: checkout.dir,
          baseSha: checkout.baseSha,
          headSha: checkout.headSha,
          backgroundFile,
          ruleFile,
          outputFile,
          concurrency: request.concurrency ?? config.OCR_CONCURRENCY,
          // A minute under the kill, so ocr stops on its own and writes what it has first.
          timeoutMinutes: providerTimeoutMinutes(timeoutMs),
          tokenBudget: request.tokenBudget ?? config.OCR_TOKEN_BUDGET,
        }),
        cwd: checkout.dir,
        env: () => provider.buildChildEnv(),
        timeoutMs,
        signal,
        groups: passOpts.groups,
        onStderrLine: (line) => {
          const text = provider.forwardLogLine(line);
          if (text) onLog('info', `second opinion: ${text}`);
        },
      });
      if (fs.existsSync(outputFile)) raw.output = fs.readFileSync(outputFile, 'utf8');
      if (exit.code !== 0) {
        const tail = sanitizeLogMessage(exit.stderrTail.trim().slice(-MAX_ERROR_TAIL));
        return fail(`second opinion ${name}`, `${provider.describeFailure(exit.stderrTail, exit.code)}${tail ? `\n${tail}` : ''}`);
      }
      result = provider.parseOutput(outputFile);
    } catch (err) {
      if (signal?.aborted) throw err;
      const message = (err as Error).message;
      return fail(
        `second opinion ${name}`,
        /timed out/.test(message) ? `${provider.bin} timed out after ${Math.round(timeoutMs / 1000)}s` : `${provider.bin}: ${message}`,
      );
    }

    const elapsed = result.elapsed_ms ?? Date.now() - providerStarted;
    const sorted = sortComments(result.comments);
    onLog('info', `second opinion ${name}: ${providerLine(result, elapsed)}`);
    if (result.partial) onLog('warn', `second opinion: not every file was reviewed (${result.provider_status ?? 'partial'}).`);
    update({
      model: result.model ?? null,
      tokens: result.tokens ?? null,
      files_reviewed: result.files_reviewed ?? null,
      partial: Boolean(result.partial),
      elapsed_ms: elapsed,
      comments_total: sorted.length,
      comments: sorted.map((c) => ({ ...c, assessment: null })),
    });

    if (sorted.length === 0) {
      update({ status: 'done', conclusion: NOTHING_FOUND, finished_at: now() });
      return finish(primary);
    }

    const sent = sorted.slice(0, MAX_ASSESSED_COMMENTS);
    const conclusionLog: OnLog = (level, message) => onLog(level, `[conclusion] ${message}`);
    onLog('info', 'conclusion: started');
    let output: ReviewOutput;
    let merged: ReturnType<typeof mergeAssessments>;
    let conclusion: string;
    try {
      const prompt = await buildConclusionPrompt(ctx.vars, primary, sent);
      const { data, json } = await runPass(
        'conclusion', prompt, conclusionOutputSchema(primary.findings.length), conclusionLog, passOpts,
      );
      raw.conclusion = json;
      merged = mergeAssessments(sorted, sent.length, data, primary.findings.length, conclusionLog);
      let added = merged.findings;
      if (added.length) {
        const anchorCtx = createAnchorContext(checkout.dir, checkoutChangedFiles(checkout));
        const anchored = await anchorWithReanchor(anchorCtx, added, ctx.vars, passOpts, onLog);
        added = anchored.anchors.findings;
        if (anchored.reanchorRaw !== null) raw.reanchor = anchored.reanchorRaw;
      }
      if (signal?.aborted) throw new Error('Review cancelled');
      const corroborated = new Set(merged.corroborated);
      output = normalize(
        {
          ...primary,
          findings: [...primary.findings.map((f, i) => (corroborated.has(i) ? { ...f, corroborated: true } : f)), ...added],
          observations: [...primary.observations, ...merged.observations],
        },
        { slice: ctx.slice },
      );
      conclusion = data.conclusion || `The second opinion: ${countsLine(merged.counts)}.`;
    } catch (err) {
      if (signal?.aborted) throw err;
      return fail('conclusion', (err as Error).message);
    }

    onLog('info', `conclusion: ${countsLine(merged.counts)}`);
    update({
      status: 'done',
      comments: merged.comments,
      counts: merged.counts,
      conclusion,
      finished_at: now(),
    });
    return finish(output);
  } catch (err) {
    // The working files could not be written, or something else broke: the primary result stands.
    if (signal?.aborted) throw err;
    return fail(`second opinion ${name}`, (err as Error).message);
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
}
