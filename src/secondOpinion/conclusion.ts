import { z } from 'zod';
import {
  findingSchema, loadPromptFile, observationSchema, promptValues, renderTemplate, type PromptVars,
} from '../reviewRunner.js';
import type { Finding, Observation, OnLog, ReviewOutput } from '../types.js';
import { emptyCounts } from './state.js';
import type { AssessedComment, AssessmentCounts, CommentAssessment, SecondOpinionComment } from './types.js';

/** At most this many comments go into the conclusion pass; the rest are `not_assessed`. */
export const MAX_ASSESSED_COMMENTS = 40;

export const NOTHING_FOUND = 'The second opinion found nothing beyond the primary review.';

const SEVERITY_RANK: Record<string, number> = {
  critical: 0, blocker: 0, high: 1, major: 1, medium: 2, moderate: 2, low: 3, minor: 3, info: 4, nit: 4,
};

/** Highest provider severity first; the provider's own order within a severity. */
export function sortComments(comments: readonly SecondOpinionComment[]): SecondOpinionComment[] {
  return comments
    .map((c, i) => ({ c, i }))
    .sort((a, b) => ((SEVERITY_RANK[a.c.severity] ?? 5) - (SEVERITY_RANK[b.c.severity] ?? 5)) || (a.i - b.i))
    .map(({ c }) => c);
}

// --- the answer ---------------------------------------------------------------

const VERDICT_ALIASES: Record<string, ConclusionVerdict> = {
  confirm: 'confirmed', confirmed: 'confirmed', valid: 'confirmed',
  duplicate: 'duplicate', duplicated: 'duplicate', dup: 'duplicate',
  observation: 'observation', observe: 'observation',
  reject: 'rejected', rejected: 'rejected', invalid: 'rejected',
};

type ConclusionVerdict = 'confirmed' | 'duplicate' | 'observation' | 'rejected';

const verdictSchema = z.string().transform((v, ctx) => {
  const key = v.trim().toLowerCase().replace(/[\s-]+/g, '_');
  const verdict = VERDICT_ALIASES[key];
  if (!verdict) {
    ctx.addIssue({ code: 'custom', message: `unknown verdict ${JSON.stringify(v)}; use confirmed, duplicate, observation or rejected` });
    return z.NEVER;
  }
  return verdict;
});

export interface ConclusionAssessment {
  comment: number;
  verdict: ConclusionVerdict;
  reason: string;
  duplicate_of: number | null;
  finding: Finding | null;
  observation: Observation | null;
}

export interface ConclusionAnswer {
  assessments: ConclusionAssessment[];
  conclusion: string;
}

const optionalInt = z.union([z.number(), z.string()]).nullish()
  .transform((v) => {
    const n = typeof v === 'string' ? Number(v.replace(/[^\d]/g, '')) : v;
    return typeof n === 'number' && Number.isInteger(n) && n > 0 ? n : null;
  });

/**
 * The conclusion pass's answer. Lenient where the model is sloppy (verdict
 * spelling, a missing reason or observation), strict where the merge needs a
 * value: a `confirmed` without a valid finding, or a `duplicate` that does not
 * name one of the `primaryFindings` findings, gets the corrective retry.
 */
export function conclusionOutputSchema(primaryFindings: number): z.ZodType<ConclusionAnswer> {
  const assessment = z.object({
    comment: z.coerce.number().int(),
    verdict: verdictSchema,
    reason: z.string().nullish().transform((v) => v?.trim() ?? ''),
    duplicate_of: optionalInt,
    finding: z.unknown().optional(),
    observation: z.unknown().optional(),
  }).transform((a, ctx): ConclusionAssessment => {
    let finding: Finding | null = null;
    let observation: Observation | null = null;
    if (a.verdict === 'confirmed') {
      const parsed = findingSchema.safeParse(a.finding);
      if (!parsed.success) {
        const why = parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ');
        ctx.addIssue({ code: 'custom', message: `comment ${a.comment} is confirmed without a valid finding (${why})` });
        return z.NEVER;
      }
      finding = parsed.data as Finding;
    }
    if (a.verdict === 'duplicate' && (a.duplicate_of === null || a.duplicate_of > primaryFindings)) {
      ctx.addIssue({
        code: 'custom',
        message: `comment ${a.comment} is a duplicate, but duplicate_of must be a finding number from 1 to ${primaryFindings}`,
      });
      return z.NEVER;
    }
    if (a.verdict === 'observation') {
      const parsed = observationSchema.safeParse(a.observation);
      observation = parsed.success ? parsed.data : null;
    }
    return {
      comment: a.comment,
      verdict: a.verdict,
      reason: a.reason,
      duplicate_of: a.verdict === 'duplicate' ? a.duplicate_of : null,
      finding,
      observation,
    };
  });
  return z.object({
    assessments: z.array(assessment).nullish().transform((v) => v ?? []),
    conclusion: z.string().nullish().transform((v) => v?.trim() ?? ''),
  });
}

// --- the prompt ---------------------------------------------------------------

function location(file: string | null, line: number | null, endLine?: number | null): string {
  if (!file) return 'no location';
  if (!line) return file;
  return endLine && endLine > line ? `${file}:${line}-${endLine}` : `${file}:${line}`;
}

function oneLine(text: string | null | undefined): string {
  return (text ?? '').replace(/\s+/g, ' ').trim();
}

/** `{{PRIMARY_FINDINGS}}`: the finished review's findings by number, then its observations. */
export function renderPrimaryFindings(output: Pick<ReviewOutput, 'findings' | 'observations'>): string {
  const findings = output.findings.map((f, i) => {
    const kind = f.kind && f.kind !== 'diff' ? `, ${f.kind}, caused by ${location(f.cause_file, f.cause_line)}` : '';
    return `${i + 1}. [${f.severity}${kind}] ${location(f.file, f.line, f.end_line)}: ${oneLine(f.title)}. ${oneLine(f.problem)}`;
  });
  const observations = output.observations.map((o, i) =>
    `O${i + 1}. ${location(o.file, o.line)}: ${oneLine(o.note)}`);
  return [
    '## Findings',
    '',
    findings.length ? findings.join('\n') : 'None.',
    '',
    '## Observations',
    '',
    observations.length ? observations.join('\n') : 'None.',
  ].join('\n');
}

function fence(text: string): string {
  return ['```', text.replace(/```/g, "'''").trimEnd(), '```'].join('\n');
}

/** `{{SECOND_OPINION}}`: the comments the pass assesses, numbered from 1. */
export function renderSecondOpinionComments(comments: readonly SecondOpinionComment[]): string {
  return comments.map((c, i) => {
    const lines = c.end_line > c.start_line ? `${c.start_line}-${c.end_line}` : String(c.start_line);
    const parts = [
      `## Comment ${i + 1}: ${c.path || '(no path)'}:${lines} (tool severity ${c.severity}, category ${c.category})`,
      '',
      c.content.trim(),
    ];
    if (c.existing_code) parts.push('', 'Existing code:', fence(c.existing_code));
    if (c.suggestion_code) parts.push('', 'Suggested code:', fence(c.suggestion_code));
    return parts.join('\n');
  }).join('\n\n');
}

export async function buildConclusionPrompt(
  vars: PromptVars,
  primary: Pick<ReviewOutput, 'findings' | 'observations'>,
  comments: readonly SecondOpinionComment[],
): Promise<string> {
  const values = {
    ...promptValues(vars),
    PRIMARY_FINDINGS: renderPrimaryFindings(primary),
    SECOND_OPINION: renderSecondOpinionComments(comments),
  };
  const [preamble, mandate] = await Promise.all([
    loadPromptFile('common-preamble.md'),
    loadPromptFile('second-opinion.md'),
  ]);
  return [preamble, mandate].map((t) => renderTemplate(t, values)).join('\n\n');
}

// --- the merge ----------------------------------------------------------------

export interface MergedAssessments {
  /** Confirmed comments as findings, in comment order, not anchored yet; `lens` is `second_opinion`. */
  findings: Finding[];
  observations: Observation[];
  /** Indexes of the primary findings a comment repeats. */
  corroborated: number[];
  comments: AssessedComment[];
  counts: AssessmentCounts;
}

/**
 * Applies the assessments to the sorted comments. The first `assessed`
 * comments were sent to the pass; the rest, and any it left out, are
 * `not_assessed`. A confirmed comment's `finding_ord` is where its finding
 * lands: after the `primaryCount` primary findings.
 */
export function mergeAssessments(
  comments: readonly SecondOpinionComment[],
  assessed: number,
  answer: ConclusionAnswer,
  primaryCount: number,
  onLog: OnLog = () => {},
): MergedAssessments {
  const byComment = new Map<number, ConclusionAssessment>();
  for (const a of answer.assessments) {
    if (a.comment < 1 || a.comment > assessed) {
      onLog('warn', `conclusion: dropped an assessment of comment ${a.comment}, which was not sent`);
      continue;
    }
    if (byComment.has(a.comment)) {
      onLog('warn', `conclusion: comment ${a.comment} was assessed twice; the first one counts`);
      continue;
    }
    byComment.set(a.comment, a);
  }

  const findings: Finding[] = [];
  const observations: Observation[] = [];
  const corroborated = new Set<number>();
  const counts = emptyCounts();
  const out = comments.map((comment, index): AssessedComment => {
    const a = index < assessed ? byComment.get(index + 1) : undefined;
    let assessment: CommentAssessment;
    if (!a) {
      assessment = {
        verdict: 'not_assessed',
        reason: index < assessed
          ? 'The conclusion pass gave no assessment for this comment.'
          : `Not assessed: only the first ${assessed} comments, highest severity first, are checked.`,
        duplicate_of: null,
        finding_ord: null,
      };
    } else if (a.verdict === 'confirmed' && a.finding) {
      assessment = { verdict: 'confirmed', reason: a.reason, duplicate_of: null, finding_ord: primaryCount + findings.length };
      findings.push({ ...a.finding, lens: 'second_opinion' });
    } else if (a.verdict === 'duplicate' && a.duplicate_of !== null) {
      corroborated.add(a.duplicate_of - 1);
      assessment = { verdict: 'duplicate', reason: a.reason, duplicate_of: a.duplicate_of, finding_ord: a.duplicate_of - 1 };
    } else if (a.verdict === 'observation') {
      observations.push({
        ...(a.observation ?? {
          file: comment.path || null,
          line: comment.start_line,
          note: a.reason || comment.content.slice(0, 1_000),
          rationale: '',
        }),
        lens: 'second_opinion',
      });
      assessment = { verdict: 'observation', reason: a.reason, duplicate_of: null, finding_ord: null };
    } else {
      assessment = { verdict: 'rejected', reason: a.reason || 'No reason given.', duplicate_of: null, finding_ord: null };
    }
    counts[assessment.verdict] += 1;
    return { ...comment, assessment };
  });
  return { findings, observations, corroborated: [...corroborated].sort((x, y) => x - y), comments: out, counts };
}
