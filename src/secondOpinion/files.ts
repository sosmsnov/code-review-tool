import type { TicketInfo } from '../types.js';

/** ocr refuses a longer `--background-file`. */
export const MAX_BACKGROUND_CHARS = 8_000;

const TRIMMED = '\n\n(trimmed)';

export interface BackgroundInput {
  ticketKey: string | null;
  ticketTitle: string | null;
  /** The ticket text: tracker body and comments, or pasted requirements. */
  ticketBody: string | null;
  comments?: TicketInfo['comments'];
  /** The stored checklist, as `R<id> <text>`. */
  checklist?: { id: number; text: string }[];
  /** Pasted requirements or approved decisions of the ticket group. */
  requirementsText?: string | null;
  /** The rendered ticket scope of a slice; empty for a branch without a group. */
  ticketScope?: string;
}

function section(title: string, body: string): string {
  return `## ${title}\n\n${body.trim()}`;
}

/**
 * The provider's background file: what the branch must do, in this order:
 * the ticket, its checklist, the approved decisions, the slice scope, then the
 * ticket text. Over the cap, the ticket text is trimmed first.
 */
export function buildBackground(input: BackgroundInput, cap = MAX_BACKGROUND_CHARS): string {
  const head: string[] = [];
  const title = [input.ticketKey, input.ticketTitle?.trim()].filter(Boolean).join(': ');
  head.push(`# ${title || 'Change under review'}`);
  if (input.checklist?.length) {
    head.push(section('Requirements', input.checklist.map((c) => `- R${c.id} ${c.text.replace(/\s+/g, ' ').trim()}`).join('\n')));
  }
  if (input.requirementsText?.trim()) head.push(section('Requirements and approved decisions', input.requirementsText));
  if (input.ticketScope?.trim()) head.push(input.ticketScope.trim());

  const bodyParts: string[] = [];
  if (input.ticketBody?.trim()) bodyParts.push(input.ticketBody.trim());
  for (const c of input.comments ?? []) {
    if (c.body?.trim()) bodyParts.push(`- ${c.author || 'unknown'}: ${c.body.trim()}`);
  }

  const headText = head.join('\n\n');
  if (!bodyParts.length) return clip(headText, cap);
  const bodyTitle = '\n\n## Ticket\n\n';
  const bodyText = bodyParts.join('\n\n');
  const full = `${headText}${bodyTitle}${bodyText}`;
  if (full.length <= cap) return full;
  const room = cap - headText.length - bodyTitle.length - TRIMMED.length;
  if (room <= 200) return clip(headText, cap);
  return `${headText}${bodyTitle}${bodyText.slice(0, room).trimEnd()}${TRIMMED}`;
}

function clip(text: string, cap: number): string {
  return text.length <= cap ? text : `${text.slice(0, cap - TRIMMED.length).trimEnd()}${TRIMMED}`;
}

/**
 * The provider's `--rule` file: the repository rules for every path. Test
 * files are left to ocr's own defaults (it skips them): the primary review
 * reads them already.
 */
export function buildRuleFile(rulesText: string): string {
  const text = rulesText.trim();
  const body = text ? { rules: [{ path: '**/*', rule: text, merge_system_rule: true }] } : {};
  return `${JSON.stringify(body, null, 2)}\n`;
}
