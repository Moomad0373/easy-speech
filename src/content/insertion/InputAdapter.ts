import type { InsertionTarget, TargetSummary } from '../../shared/types';

export interface AdapterValidation {
  ok: boolean;
  reason?: string;
}

/** Result of committing a final transcript through TargetManager. */
export interface AdapterCommitResult {
  ok: boolean;
  error?: string;
  target: TargetSummary | null;
}

/**
 * Strategy interface for inserting text into one kind of editable element
 * (spec §12). Site-specific adapters (GoogleDocsAdapter, ChatGPTAdapter, ...)
 * can be added later without touching recognition or messaging code (§30).
 */
export interface InputAdapter {
  /** Discriminator used by TargetManager to route targets. */
  readonly kind: 'form-control' | 'contenteditable';
  canHandle(element: Element): boolean;
  captureTarget(element: Element): InsertionTarget | null;
  validateTarget(target: InsertionTarget): AdapterValidation;
  insertText(target: InsertionTarget, text: string): AdapterValidation;
  replaceText(target: InsertionTarget, text: string, previousText: string): AdapterValidation;
  /** Characters immediately before the caret (word-boundary spacing). */
  textBeforeCaret(target: InsertionTarget): string;
  /**
   * Write the live (interim) transcript into the element at the caret as a
   * transient preview. Repeated calls REPLACE the previous preview; the next
   * insertText() call replaces the preview with the final transcript (§14).
   */
  previewText(target: InsertionTarget, text: string): AdapterValidation;
  /** Drop preview tracking, keeping any previewed text as ordinary text. */
  resetPreview(target: InsertionTarget): void;
}

/** Text-like input types supported in v1 (spec §31). */
export const SUPPORTED_INPUT_TYPES: ReadonlySet<string> = new Set([
  'text',
  'search',
  'email',
  'url',
  'tel',
]);

export type FormControl = HTMLInputElement | HTMLTextAreaElement;

const NO_SPACE_BEFORE = new Set(['(', '[', '{', '«', '"', '\u2018', '\u201C', '\u2039']);

/**
 * Word-boundary rule for dictation across sessions and phrases: when the
 * character before the caret is a visible, non-opening character and the new
 * text starts with a letter/digit, the segments need a separating space.
 * Text that already carries leading whitespace or starts with punctuation
 * (voice commands, hugging punctuation) is inserted verbatim.
 */
export function withWordBoundarySpace(before: string, text: string): string {
  if (text.length === 0) return text;
  const first = text[0]!;
  if (/\s/u.test(first)) return text;
  if (!/[\p{L}\p{N}]/u.test(first)) return text;
  if (/\s$/.test(before)) return text;
  const trimmedBefore = before.replace(/[ \t]+$/, '');
  if (trimmedBefore.length === 0) return text;
  const last = trimmedBefore[trimmedBefore.length - 1]!;
  if (NO_SPACE_BEFORE.has(last)) return text;
  return ` ${text}`;
}

/**
 * Input types that do NOT implement the selection API per the HTML spec
 * (selectionStart throws or is null — e.g. type="email"). For these we
 * conservatively fall back to end-of-value insertion.
 */
export function readSelection(form: FormControl): { start: number; end: number } | null {
  try {
    const { selectionStart, selectionEnd } = form;
    if (selectionStart === null || selectionEnd === null) return null;
    return { start: selectionStart, end: selectionEnd };
  } catch {
    return null;
  }
}
