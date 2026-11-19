import { ApiError } from './api';
import type { ResolvedTarget } from './types';

export interface StartForm {
  input: string;
  targets?: ResolvedTarget[];
  requirementsText?: string;
  reviewer: string;
  model: string;
  includeWorkingTree: boolean;
  baseBranch: string;
  /** Null when the server offers no second opinion provider. */
  secondOpinion: string | null;
  reviewUnchanged: boolean;
  ignoreBudget: boolean;
}

/** The `POST /api/reviews` body: optional fields are left out when empty or off. */
export function buildStartBody(f: StartForm) {
  return {
    input: f.input,
    ...(f.targets ? { targets: f.targets } : {}),
    ...(f.requirementsText ? { requirementsText: f.requirementsText } : {}),
    reviewer: f.reviewer,
    ...(f.model.trim() ? { model: f.model.trim() } : {}),
    ...(f.includeWorkingTree ? { includeWorkingTree: true } : {}),
    ...(f.baseBranch.trim() ? { baseBranch: f.baseBranch.trim() } : {}),
    ...(f.secondOpinion !== null ? { secondOpinion: f.secondOpinion } : {}),
    ...(f.reviewUnchanged ? { reviewUnchanged: true } : {}),
    ...(f.ignoreBudget ? { ignoreBudget: true } : {}),
  };
}

/** The server refused the start because the usage budget of the window is spent (409). */
export function isBudgetRefusal(err: unknown): boolean {
  return err instanceof ApiError && err.status === 409;
}
