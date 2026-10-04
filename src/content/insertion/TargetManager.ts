import type { InsertionTarget, TargetSummary } from '../../shared/types';
import { withWordBoundarySpace } from './InputAdapter';
import type { AdapterCommitResult, InputAdapter } from './InputAdapter';

/**
 * Finds the right InputAdapter for the focused element, captures the
 * insertion target BEFORE recognition starts, validates it before every
 * restart, and commits final transcripts (spec §9, §35, §36).
 */
export class TargetManager {
  private current: InsertionTarget | null = null;

  constructor(private readonly adapters: InputAdapter[]) {}

  /** Capture the insertion point of `element`. Fails when unsupported. */
  capture(element: Element | null): { ok: boolean; reason?: string } {
    this.current = null;
    if (!element || element === document.body || element === document.documentElement) {
      return { ok: false, reason: 'no editable element is focused' };
    }
    const adapter = this.adapters.find((candidate) => candidate.canHandle(element));
    if (!adapter) {
      return { ok: false, reason: 'focused element is not a supported text field' };
    }
    const target = adapter.captureTarget(element);
    if (!target) {
      return { ok: false, reason: 'could not capture the cursor position' };
    }
    this.current = target;
    return { ok: true };
  }

  /** True when there is a captured target and it is still valid (spec §36). */
  validate(): { ok: boolean; reason?: string } {
    if (!this.current) return { ok: false, reason: 'no captured target' };
    const adapter = this.adapterFor(this.current);
    if (!adapter) return { ok: false, reason: 'no adapter for the captured target' };
    return adapter.validateTarget(this.current);
  }

  /** Insert a final transcript at the captured position (spec §13, §37). */
  commit(text: string): AdapterCommitResult {
    if (!this.current) {
      return { ok: false, error: 'no captured insertion target', target: null };
    }
    const adapter = this.adapterFor(this.current);
    if (!adapter) {
      return { ok: false, error: 'no adapter for the captured target', target: null };
    }
    const result = adapter.insertText(this.current, withWordBoundarySpace(adapter.textBeforeCaret(this.current), text));
    if (!result.ok) {
      return { ok: false, error: result.reason, target: this.summarize(this.current) };
    }
    return { ok: true, target: this.summarize(this.current) };
  }

  replace(text: string, previousText: string): AdapterCommitResult {
    if (!this.current) {
      return { ok: false, error: 'no captured insertion target', target: null };
    }
    const adapter = this.adapterFor(this.current);
    if (!adapter) {
      return { ok: false, error: 'no adapter for the captured target', target: null };
    }
    const result = adapter.replaceText(this.current, text, previousText);
    if (!result.ok) {
      return { ok: false, error: result.reason, target: this.summarize(this.current) };
    }
    return { ok: true, target: this.summarize(this.current) };
  }

  /**
   * Write the live interim transcript into the captured target as a
   * transient preview. Repeated calls replace the previous preview; the next
   * commit() swaps it for the final transcript (spec §14). Best-effort:
   * failures are reported to the caller, never thrown.
   */
  preview(text: string): { ok: boolean; reason?: string } {
    if (!this.current) return { ok: false, reason: 'no captured target' };
    const adapter = this.adapterFor(this.current);
    if (!adapter) return { ok: false, reason: 'no adapter for the captured target' };
    return adapter.previewText(this.current, withWordBoundarySpace(adapter.textBeforeCaret(this.current), text));
  }

  /** Stop tracking the live preview, keeping any previewed text as real text. */
  resetPreview(): void {
    if (!this.current) return;
    this.adapterFor(this.current)?.resetPreview(this.current);
  }

  summary(): TargetSummary | null {
    return this.current ? this.summarize(this.current) : null;
  }

  clear(): void {
    this.current = null;
  }

  private adapterFor(target: InsertionTarget): InputAdapter | undefined {
    const wanted = target.type === 'contenteditable' ? 'contenteditable' : 'form-control';
    // Site-specific adapters (GoogleKeepAdapter, …) share the generic kinds,
    // so the first kind-match is NOT necessarily the right adapter for this
    // element — prefer one that canHandle() it (host gates, editability),
    // and fall back to the generic kind-match only for error reporting
    // (validation then produces the precise reason, e.g. removed/disabled).
    return (
      this.adapters.find((adapter) => adapter.kind === wanted && adapter.canHandle(target.element)) ??
      this.adapters.find((adapter) => adapter.kind === wanted)
    );
  }

  private summarize(target: InsertionTarget): TargetSummary {
    const element = target.element;
    return {
      kind: target.type,
      selector: buildSelector(element),
      connected: element.isConnected,
    };
  }
}

/** Best-effort CSS selector for error reporting (id wins, else short tag path). */
export function buildSelector(element: Element): string {
  if (element.id) return `#${element.id}`;
  const parts: string[] = [];
  let current: Element | null = element;
  let depth = 0;
  while (current && current.nodeType === Node.ELEMENT_NODE && depth < 4) {
    let part = current.tagName.toLowerCase();
    if (current.id) {
      parts.unshift(`#${current.id}`);
      break;
    }
    const className = typeof current.className === 'string' ? current.className.trim() : '';
    if (className) {
      part += className
        .split(/\s+/)
        .slice(0, 2)
        .map((c) => `.${c}`)
        .join('');
    }
    const parent: Element | null = current.parentElement;
    if (parent) {
      const sameTagSiblings = Array.from(parent.children).filter((c) => c.tagName === current?.tagName);
      if (sameTagSiblings.length > 1) {
        part += `:nth-of-type(${sameTagSiblings.indexOf(current) + 1})`;
      }
    }
    parts.unshift(part);
    current = parent;
    depth += 1;
  }
  return parts.join(' > ') || element.tagName.toLowerCase();
}
