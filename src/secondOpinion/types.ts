// Imports nothing of ours: config.ts reads the provider names from here.

/** External reviewer CLIs that can give a second opinion on a review. */
export const SECOND_OPINION_NAMES = ['ocr'] as const;
export type SecondOpinionName = (typeof SECOND_OPINION_NAMES)[number];

/** What a request may name: a provider, or `none` for no second opinion. */
export const SECOND_OPINION_CHOICES = ['none', ...SECOND_OPINION_NAMES] as const;
export type SecondOpinionChoice = (typeof SECOND_OPINION_CHOICES)[number];

export function isSecondOpinionName(value: unknown): value is SecondOpinionName {
  return typeof value === 'string' && (SECOND_OPINION_NAMES as readonly string[]).includes(value);
}

export interface SecondOpinionInput {
  /** The host checkout; the provider only reads it. */
  dir: string;
  baseSha: string;
  headSha: string;
  backgroundFile: string;
  ruleFile: string;
  outputFile: string;
  concurrency: number;
  timeoutMinutes: number;
  tokenBudget: number;
}

/** One comment of the provider, as it reported it. Severity and category are its own labels. */
export interface SecondOpinionComment {
  path: string;
  start_line: number;
  end_line: number;
  severity: string;
  category: string;
  content: string;
  existing_code?: string;
  suggestion_code?: string;
}

export interface SecondOpinionTokens {
  total: number;
  input: number;
  output: number;
  /** Cached tokens, counted inside `input` by the provider; absent when it does not report them. */
  cache_read?: number;
  cache_write?: number;
}

export interface SecondOpinionResult {
  comments: SecondOpinionComment[];
  files_reviewed?: number;
  tokens?: SecondOpinionTokens;
  elapsed_ms?: number;
  model?: string;
  provider_status?: string;
  /** Some files were not reviewed (a budget stop or a failed item); the comments are still usable. */
  partial?: boolean;
  raw: unknown;
}

export interface SecondOpinionProvider {
  readonly name: SecondOpinionName;
  readonly label: string;
  readonly bin: string;
  /** Whether the binary exists on this machine. Cached after the first call. */
  isAvailable(): boolean;
  /** A human hint for the failure; never empty. */
  describeFailure(stderrTail: string, exitCode: number | null): string;
  buildArgs(input: SecondOpinionInput): string[];
  buildChildEnv(): NodeJS.ProcessEnv;
  /** Reads the output file; throws when it is missing or not the expected JSON. */
  parseOutput(outputFile: string): SecondOpinionResult;
  /** One stderr line as review log text, or null to drop it. */
  forwardLogLine(line: string): string | null;
}

export const ASSESSMENT_VERDICTS = ['confirmed', 'duplicate', 'observation', 'rejected', 'not_assessed'] as const;
export type AssessmentVerdict = (typeof ASSESSMENT_VERDICTS)[number];

export interface CommentAssessment {
  verdict: AssessmentVerdict;
  reason: string;
  /** `duplicate`: the 1-based number of the primary finding it repeats. */
  duplicate_of: number | null;
  /** `confirmed`: the `ord` of the finding it became; `duplicate`: the `ord` of the primary finding. */
  finding_ord: number | null;
}

export type AssessedComment = SecondOpinionComment & { assessment: CommentAssessment | null };

export type SecondOpinionStatus = 'pending' | 'skipped' | 'running' | 'done' | 'failed';

export type AssessmentCounts = Record<AssessmentVerdict, number>;

/** `reviews.second_opinion`, as stored (JSON) and served. */
export interface SecondOpinionState {
  provider: SecondOpinionName;
  status: SecondOpinionStatus;
  requested_at: string | null;
  started_at: string | null;
  finished_at: string | null;
  elapsed_ms: number | null;
  model: string | null;
  tokens: SecondOpinionTokens | null;
  files_reviewed: number | null;
  partial: boolean;
  comments_total: number;
  counts: AssessmentCounts;
  comments: AssessedComment[];
  conclusion: string | null;
  primary_verdict: string | null;
  primary_can_merge: boolean | null;
  error: string | null;
}
