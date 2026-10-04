import type { InsertionTarget } from '../../shared/types';
import { readSelection, SUPPORTED_INPUT_TYPES } from './InputAdapter';
import type { AdapterValidation, InputAdapter } from './InputAdapter';

export interface FormControlAdapterOptions {
  /** Dictating into password fields is risky; disabled by default (spec §9B). */
  allowPassword?: boolean;
}

type FormControl = HTMLInputElement | HTMLTextAreaElement;

/**
 * Adapter for <input type="text|search|email|url|tel"> and <textarea>.
 *
 * Sets the value through the prototype's native value setter and dispatches a
 * bubbling 'input' event so React/Vue/Angular controlled components register
 * the change (spec §11). Text is inserted exactly at the captured caret and
 * replaces the captured selection — never appended blindly (spec §13).
 */
export class FormControlAdapter implements InputAdapter {
  readonly kind = 'form-control' as const;

  constructor(private readonly options: FormControlAdapterOptions = {}) {}

  canHandle(element: Element): boolean {
    if (element instanceof HTMLTextAreaElement) {
      return !element.disabled && !element.readOnly;
    }
    if (element instanceof HTMLInputElement) {
      if (element.disabled || element.readOnly) return false;
      if (element.type === 'password') return this.options.allowPassword === true;
      return SUPPORTED_INPUT_TYPES.has(element.type);
    }
    return false;
  }

  captureTarget(element: Element): InsertionTarget | null {
    if (!this.canHandle(element)) return null;
    const form = element as FormControl;
    // Cursor is captured BEFORE recognition starts (spec §10). For input
    // types without a selection API (email etc.) we fall back to end-of-value.
    const selection = readSelection(form) ?? { start: form.value.length, end: form.value.length };
    return form instanceof HTMLTextAreaElement
      ? { type: 'textarea', element: form, ...selection }
      : { type: 'input', element: form, ...selection };
  }

  validateTarget(target: InsertionTarget): AdapterValidation {
    if (target.type !== 'input' && target.type !== 'textarea') {
      return { ok: false, reason: 'not a form control target' };
    }
    const form = target.element;
    if (!form.isConnected) return { ok: false, reason: 'element removed from the document' };
    if (form.disabled) return { ok: false, reason: 'element is disabled' };
    if (form.readOnly) return { ok: false, reason: 'element is read-only' };
    return { ok: true };
  }

  insertText(target: InsertionTarget, text: string): AdapterValidation {
    if (target.type !== 'input' && target.type !== 'textarea') {
      return { ok: false, reason: 'not a form control target' };
    }
    const form = target.element;
    const check = this.validateTarget(target);
    if (!check.ok) return check;

    // A live preview is on screen: replace it with the final transcript
    // exactly where the preview sits — the caret-sync below is skipped on
    // this path so the words land where the user watched them appear (§14).
    if (target.previewStart !== null && target.previewStart !== undefined) {
      const value = form.value;
      const start = Math.min(Math.max(target.previewStart, 0), value.length);
      const end = Math.min(Math.max(target.previewEnd ?? start, start), value.length);
      // If the site/framework rewrote the value since the preview, the
      // previewed words are gone — abandon the preview rather than clobber
      // whatever replaced them.
      const previewText = target.previewText;
      const stillThere = previewText === null || previewText === undefined || value.slice(start, end) === previewText;
      if (stillThere) {
        const final = this.sanitize(target, text, start);
        this.setValue(form, target.type, value.slice(0, start) + final + value.slice(end));
        const caret = start + final.length;
        try {
          form.setSelectionRange(caret, caret);
        } catch {
          /* types without a selection API (email etc.) */
        }
        target.start = caret;
        target.end = caret;
        target.previewStart = null;
        target.previewEnd = null;
        target.previewText = null;
        return { ok: true };
      }
      target.previewStart = null;
      target.previewEnd = null;
      target.previewText = null;
    }

    // If the user deliberately repositioned the caret inside the SAME field
    // during dictation, honor the live caret; otherwise use the captured one.
    if (document.activeElement === form) {
      const live = readSelection(form);
      if (live) {
        target.start = live.start;
        target.end = live.end;
      }
    }

    const value = form.value;
    const start = Math.min(Math.max(target.start, 0), value.length);
    const end = Math.min(Math.max(target.end, start), value.length);
    const sanitized = this.sanitize(target, text, start);
    const newValue = value.slice(0, start) + sanitized + value.slice(end);

    this.setValue(form, target.type, newValue);

    // Caret ends up directly after the inserted text (spec §10/§13) and the
    // stored position advances so the next phrase continues from here (§14).
    const caret = start + sanitized.length;
    try {
      form.setSelectionRange(caret, caret);
    } catch {
      /* types without a selection API (email etc.) — value insertion still worked */
    }
    target.start = caret;
    target.end = caret;
    return { ok: true };
  }

  replaceText(target: InsertionTarget, text: string, previousText: string): AdapterValidation {
    if (target.type !== 'input' && target.type !== 'textarea') {
      return { ok: false, reason: 'not a form control target' };
    }
    const form = target.element;
    const check = this.validateTarget(target);
    if (!check.ok) return check;

    const value = form.value;
    const startPosition = target.previewStart ?? target.start;
    const endPosition = target.previewEnd ?? target.end;
    const expected = previousText.trim();
    if (expected.length === 0) return { ok: false, reason: 'previous transcript is empty' };
    let start = startPosition - previousText.length;
    if (start < 0 || value.slice(start, startPosition).trim() !== expected) {
      start = startPosition - expected.length;
    }
    const end = Math.max(start, Math.min(endPosition, value.length));
    if (start < 0 || value.slice(start, startPosition).trim() !== expected) {
      return { ok: false, reason: 'previous transcript is no longer at the caret' };
    }

    const replacement = this.sanitize(target, text, start);
    this.setValue(form, target.type, value.slice(0, start) + replacement + value.slice(end));
    const caret = start + replacement.length;
    try {
      form.setSelectionRange(caret, caret);
    } catch {
      /* types without a selection API */
    }
    target.start = caret;
    target.end = caret;
    target.previewStart = null;
    target.previewEnd = null;
    target.previewText = null;
    return { ok: true };
  }

  /**
   * Live-dictation preview: write the pending transcript at the caret now.
   * The first call anchors the preview to the live caret (or the captured
   * position when the field lost focus); later calls replace the previewed
   * range in place, and insertText() swaps it for the final transcript.
   */
  previewText(target: InsertionTarget, text: string): AdapterValidation {
    if (target.type !== 'input' && target.type !== 'textarea') {
      return { ok: false, reason: 'not a form control target' };
    }
    const check = this.validateTarget(target);
    if (!check.ok) return check;
    const form = target.element;

    if (target.previewStart === null || target.previewStart === undefined) {
      let start = target.start;
      let end = target.end;
      if (document.activeElement === form) {
        const live = readSelection(form);
        if (live) {
          start = live.start;
          end = live.end;
        }
      }
      target.previewStart = start;
      target.previewEnd = end;
    }

    const value = form.value;
    const start = Math.min(Math.max(target.previewStart, 0), value.length);
    const end = Math.min(Math.max(target.previewEnd ?? start, start), value.length);
    const preview = this.sanitize(target, text, start);
    this.setValue(form, target.type, value.slice(0, start) + preview + value.slice(end));

    const caret = start + preview.length;
    try {
      form.setSelectionRange(caret, caret);
    } catch {
      /* types without a selection API (email etc.) */
    }
    target.previewEnd = caret;
    target.previewText = preview;
    return { ok: true };
  }

  textBeforeCaret(target: InsertionTarget): string {
    if (target.type !== 'input' && target.type !== 'textarea') return '';
    const form = target.element;
    if (!form.isConnected) return '';
    let position = target.previewStart ?? target.start;
    if (target.previewStart == null && document.activeElement === form) {
      const live = readSelection(form);
      if (live) position = live.start;
    }
    return form.value.slice(0, Math.min(Math.max(position, 0), form.value.length));
  }

  resetPreview(target: InsertionTarget): void {
    if (target.type !== 'input' && target.type !== 'textarea') return;
    target.previewStart = null;
    target.previewEnd = null;
    target.previewText = null;
  }

  // ---- helpers ----

  /** Newline flattening for single-line inputs + engine-space rule at start. */
  private sanitize(target: InsertionTarget, text: string, start: number): string {
    let sanitized = target.type === 'input' ? text.replace(/\r?\n+/g, ' ') : text;
    // The browser's speech engine prefixes utterances with a space; drop it
    // when the insertion point is at the very beginning of the field.
    if (start === 0) {
      sanitized = sanitized.replace(/^\s+/, '');
    }
    return sanitized;
  }

  /**
   * Native prototype setter: bypasses framework value trackers so React
   * & co. treat this exactly like user typing (spec §11).
   */
  private setValue(form: FormControl, type: 'input' | 'textarea', newValue: string): void {
    const proto: unknown = type === 'textarea' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
    if (setter) {
      setter.call(form, newValue);
    } else {
      form.value = newValue;
    }
    form.dispatchEvent(new Event('input', { bubbles: true }));
  }
}
