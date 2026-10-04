import type { InsertionTarget } from '../../shared/types';
import type { AdapterValidation, InputAdapter } from './InputAdapter';

const CONTENTEDITABLE_SELECTOR = '[contenteditable="true"], [contenteditable=""], [contenteditable="plaintext-only"]';

/**
 * How far (in textContent characters) a preview-reclaim match may sit from
 * the preview's recorded offset before it is considered a different span.
 * Sites that rebuild their editors preserve text, so the real preview stays
 * within a few characters of where it was recorded; anything further is a
 * coincidental repetition that must never be wiped (see findWhitespaceTolerant).
 */
const RECLAIM_WINDOW_CHARS = 256;
const PREVIEW_MATCH_OFFSET_TOLERANCE = 4;

/**
 * Characters of surrounding text kept with a remembered anchor, and how far
 * the anchor may be re-aligned when the editor's text changed around it.
 */
const ANCHOR_CONTEXT_BEFORE = 16;
const ANCHOR_CONTEXT_AFTER = 8;
const ANCHOR_REALIGN_WINDOW = 48;

/** Whitespace variants sites substitute when they re-flow their editors. */
const WHITESPACE_CHARACTERS: ReadonlySet<string> = new Set([
  ' ', '\t', '\n', '\r', '\f', '\v', '\u00a0', '\u2007', '\u202f', '\u200b',
]);

/**
 * A remembered dictation position plus the text that surrounded it when it was
 * recorded. The offset alone is not a safe anchor: sites that rebuild their
 * editors (Google Keep above all) rewrite whitespace, add or drop characters
 * and merge lines, so a bare offset silently drifts. A few characters too
 * early or late lands the caret INSIDE a word — and the user's next Enter
 * then splits that line mid-word, keeping its first characters behind
 * (reported: "Enter leaves the first two characters on the line"). The
 * surrounding text identifies the position across such edits.
 */
type Anchor = {
  offset: number;
  before: string;
  after: string;
};

/**
 * Adapter for contenteditable elements (spec §9C). Text is inserted with
 * DOM Range APIs using document.createTextNode()/createElement('br') only —
 * spoken content is untrusted and is NEVER turned into HTML (spec §39).
 *
 * Multi-line transcripts become text nodes separated by <br> elements.
 */
export class ContentEditableAdapter implements InputAdapter {
  readonly kind = 'contenteditable' as const;

  /**
   * Last caret position we wrote to, per editor root, anchored to the text
   * that surrounded it. Site rebuilds detach Range objects but preserve text,
   * so this is the anchor of record for re-anchoring after a rebuild — it
   * keeps dictation continuing where the user was instead of at the end of the
   * content (the old fallback, observed as the caret jumping behind the text
   * and then to the start on Keep).
   */
  private readonly rememberedAnchors = new WeakMap<HTMLElement, Anchor>();

  /**
   * True when the in-flight write adopted the live DOM selection as its
   * insertion point. Set by noteUserCaretAdopted() and consulted by
   * healRemappedRange() so an adopted (user-owned) caret is never re-anchored
   * to the remembered dictation position.
   */
  private userCaretAdoptedThisWrite = false;

  /** Record `range` (a collapsed caret inside root) as the resume anchor. */
  protected rememberAnchor(root: HTMLElement, range: Range): void {
    try {
      if (!root.contains(range.startContainer)) return;
      const offset = this.textOffsetBefore(root, range.startContainer, range.startOffset);
      const text = root.textContent ?? '';
      this.rememberedAnchors.set(root, {
        offset,
        before: text.slice(Math.max(0, offset - ANCHOR_CONTEXT_BEFORE), offset),
        after: text.slice(offset, offset + ANCHOR_CONTEXT_AFTER),
      });
    } catch {
      /* best effort — the previous anchor stays valid */
    }
  }

  /** The remembered dictation position for `root`, if any. */
  protected recallAnchor(root: HTMLElement): number | null {
    return this.rememberedAnchors.get(root)?.offset ?? null;
  }

  /**
   * The remembered position resolved against the editor's CURRENT text.
   *
   * The recorded offset is used when the text around it still matches. When a
   * site rebuild shifted the text (an added or removed space, a re-wrapped
   * line, a soft break turned into its own paragraph) or the user typed at the
   * caret, the position is re-aligned to the closest offset whose surrounding
   * text still matches, so dictation continues at the same place in the
   * sentence instead of a few characters off — mid-word, which is what made a
   * manual Enter cut a line in the wrong place. When nothing matches, the
   * recorded offset is used as before: a possibly-imperfect position beats
   * abandoning the sentence.
   */
  protected resolveAnchor(
    root: HTMLElement,
    preferredOffset?: number | null
  ): { startContainer: Node; startOffset: number } | null {
    const anchor = this.rememberedAnchors.get(root);
    const candidate = preferredOffset ?? anchor?.offset ?? null;
    if (candidate === null) return null;
    const direct = this.locateTextOffset(root, candidate);
    if (!direct) return null;
    if (!anchor || this.anchorContextMatches(root, candidate, anchor)) return direct;
    const realigned = this.realignAnchor(root, anchor);
    return realigned ?? direct;
  }

  /**
   * Undo a rebuild's silent REMAP of the tracked range. When a site replaces
   * the nodes around the caret, the browser re-anchors the range to the
   * nearest surviving boundary — in practice the START of the editor. The
   * remapped range still "belongs to" the root, so nothing else detects it and
   * the next phrase is spliced in before the text the user already had.
   *
   * The tracked range only ever moves through our own writes (each of which
   * re-records the anchor at the same position), so a range that disagrees
   * with the anchor was moved by something else. Re-anchor it to the
   * remembered position, re-identified against the current text.
   *
   * Skipped when a live caret was adopted for this write: that position IS the
   * user's, and the anchor legitimately lags behind it.
   */
  protected healRemappedRange(
    target: Extract<InsertionTarget, { type: 'contenteditable' }>,
    root: HTMLElement
  ): void {
    if (this.userCaretAdoptedThisWrite) return;
    const range = target.range;
    // A non-collapsed range is a real text selection, never a remap artifact.
    if (!range.collapsed) return;
    if (!root.contains(range.startContainer) || !root.contains(range.endContainer)) return;
    const remembered = this.recallAnchor(root);
    if (remembered === null) return;
    let offset: number;
    try {
      offset = this.textOffsetBefore(root, range.startContainer, range.startOffset);
    } catch {
      return;
    }
    if (offset === remembered) return;
    const located = this.resolveAnchor(root, remembered);
    if (!located) return;
    try {
      range.setStart(located.startContainer, located.startOffset);
      range.setEnd(located.startContainer, located.startOffset);
    } catch {
      /* keep the remapped range — the write proceeds where it can */
    }
  }

  /**
   * True when the anchor's surrounding text sits at `offset` EXACTLY.
   * Deliberately not whitespace-tolerant: an added space means the position
   * itself moved, and accepting the stale offset would keep dictation that
   * many characters behind. The tolerant search below is what re-finds the
   * position when the text around it was re-flowed.
   */
  private anchorContextMatches(root: HTMLElement, offset: number, anchor: Anchor): boolean {
    const text = root.textContent ?? '';
    if (offset < anchor.before.length || offset + anchor.after.length > text.length) return false;
    return (
      text.slice(offset - anchor.before.length, offset) === anchor.before &&
      text.slice(offset, offset + anchor.after.length) === anchor.after
    );
  }

  /**
   * Whitespace-free view of `text`, plus the raw index of every kept
   * character (so a normalized position can be mapped back to a real offset).
   * Sites re-flow whitespace when they rebuild, so identity comparisons must
   * ignore it.
   */
  private collapseWhitespace(text: string): { value: string; map: number[] } {
    let value = '';
    const map: number[] = [];
    for (let index = 0; index < text.length; index += 1) {
      const character = text.charAt(index);
      if (WHITESPACE_CHARACTERS.has(character)) continue;
      value += character;
      map.push(index);
    }
    return { value, map };
  }

  /**
   * The recorded position re-found in the editor's current text, or null when
   * its context cannot be located nearby.
   *
   * Searches a bounded window around the recorded offset with all whitespace
   * removed, so a rebuild that re-flowed or re-wrapped the note still resolves
   * to the same place in the sentence. A bare offset cannot: it lands a few
   * characters off — inside a word — and the user's next Enter then cuts the
   * line there, leaving its first characters behind.
   *
   * Candidates are accepted in decreasing order of confidence, so a closer but
   * weaker match never wins over a slightly further exact one:
   *
   * 1. the recorded text on BOTH sides still surrounds the position;
   * 2. only the text AFTER it matches — the user typed at the caret, so the
   *    position moved to the end of what they typed and dictation continues
   *    after their words instead of a few characters behind them;
   * 3. only the text BEFORE it matches (dictation sits at the end of the
   *    content, so there is no following text to match).
   */
  private realignAnchor(root: HTMLElement, anchor: Anchor): { startContainer: Node; startOffset: number } | null {
    const text = root.textContent ?? '';
    const before = this.collapseWhitespace(anchor.before).value;
    const after = this.collapseWhitespace(anchor.after).value;
    if (before.length === 0 && after.length === 0) return null;

    const start = Math.max(0, anchor.offset - ANCHOR_REALIGN_WINDOW);
    const end = Math.min(text.length, anchor.offset + ANCHOR_REALIGN_WINDOW);
    if (end <= start) return null;
    const window = this.collapseWhitespace(text.slice(start, end));
    const recorded = this.collapseWhitespace(text.slice(start, anchor.offset)).value.length;

    const candidates: number[] = [];
    for (let distance = 0; distance <= ANCHOR_REALIGN_WINDOW; distance += 1) {
      if (recorded - distance >= 0) candidates.push(recorded - distance);
      // A position equal to the window length is valid: it is the caret at the
      // very end of the content, which is where most dictation happens.
      if (distance > 0 && recorded + distance <= window.value.length) candidates.push(recorded + distance);
    }

    const matchesAfter = (position: number): boolean =>
      after.length > 0 && position + after.length <= window.value.length &&
      window.value.slice(position, position + after.length) === after;
    const matchesBefore = (position: number): boolean =>
      before.length > 0 && position - before.length >= 0 &&
      window.value.slice(position - before.length, position) === before;

    const toPosition = (normalized: number): { startContainer: Node; startOffset: number } | null =>
      // The caret belongs immediately BEFORE the normalized character at
      // `normalized`, i.e. right after the one before it.
      this.locateTextOffset(root, Math.min(normalized === 0 ? start : start + window.map[normalized - 1]! + 1, text.length));

    for (const tier of [1, 2, 3] as const) {
      for (const position of candidates) {
        if (position > window.value.length) continue;
        const afterOk = matchesAfter(position);
        const beforeOk = matchesBefore(position);
        const accepted =
          tier === 1 ? (afterOk && beforeOk) : tier === 2 ? (afterOk && !beforeOk) : (beforeOk && !afterOk);
        if (!accepted) continue;
        const located = toPosition(position);
        if (located) return located;
      }
    }
    return null;
  }

  /**
   * Move a stale/detached range back to where dictation should continue:
   * `preferredOffset` when given (e.g. the recorded preview start — the caret
   * the user actually had), else the remembered anchor; falling back to the
   * end of content only when neither maps into the live text (site dropped
   * text). Site adapters refine the final position via anchorInsertionRange.
   */
  protected reanchorToContinue(root: HTMLElement, range: Range, preferredOffset?: number | null): void {
    const located = this.resolveAnchor(root, preferredOffset);
    if (located) {
      try {
        range.setStart(located.startContainer, located.startOffset);
        range.setEnd(located.startContainer, located.startOffset);
      } catch {
        range.selectNodeContents(root);
        range.collapse(false);
      }
    } else {
      range.selectNodeContents(root);
      range.collapse(false);
    }
    this.anchorInsertionRange(root, range);
  }

  canHandle(element: Element): boolean {
    return element instanceof HTMLElement && this.findRoot(element) !== null;
  }

  captureTarget(element: Element): InsertionTarget | null {
    const root = this.findRoot(element);
    if (!root) return null;

    const selection = window.getSelection();
    let range: Range | null = null;

    if (selection && selection.rangeCount > 0) {
      const live = selection.getRangeAt(0);
      // Only adopt the live selection when it actually intersects this root.
      if (root.contains(live.commonAncestorContainer) || live.commonAncestorContainer === root) {
        range = live.cloneRange();
      }
    }
    if (!range) {
      // No usable selection (e.g. focus without caret): caret at end of root.
      range = document.createRange();
      range.selectNodeContents(root);
      range.collapse(false);
    }

    return { type: 'contenteditable', element: root, range };
  }

  validateTarget(target: InsertionTarget): AdapterValidation {
    if (target.type !== 'contenteditable') return { ok: false, reason: 'not a contenteditable target' };
    const root = target.element;
    if (!root.isConnected) return { ok: false, reason: 'element removed from the document' };
    if (!this.canHandle(root)) return { ok: false, reason: 'element is no longer editable' };
    if (!this.rangeBelongsToRoot(target.range, root)) {
      return { ok: false, reason: 'captured range no longer belongs to the element' };
    }
    return { ok: true };
  }

  insertText(target: InsertionTarget, text: string): AdapterValidation {
    if (target.type !== 'contenteditable') return { ok: false, reason: 'not a contenteditable target' };
    const check = this.validateTarget(target);
    if (!check.ok) return check;

    const root = target.element;
    // Try to bring the editor back into focus so the user sees the caret,
    // but insertion via Range works even if focus fails (e.g. SPA overlays).
    this.focusRootForInsert(root);
    this.userCaretAdoptedThisWrite = false;

    const previewText = target.previewText ?? null;
    const previewNode = target.previewNode ?? null;

    // Live preview is tracked: the final must REPLACE it, never insert next
    // to it (spec §14). Two situations:
    // 1. Our preview text node is still attached → replace its range.
    // 2. The site normalized the DOM and detached the node, but the previewed
    //    WORDS survived as plain text (observed on ChatGPT's composer) →
    //    reclaim them at the recorded offset and replace there.
    const previewLocation = this.locatePreview(root, previewText, previewNode, target.previewOffset ?? null);
    if (previewLocation) {
      return this.replacePreviewRange(target, text, previewLocation);
    }
    if (previewNode || previewText) {
      // Preview words are really gone — drop tracking and insert normally,
      // continuing at the caret the preview started at. Without this the
      // stale range falls through to the end-of-content retry below and the
      // commit lands behind all the text (observed on Keep).
      const preferredOffset = target.previewOffset ?? null;
      target.previewNode = null;
      target.previewText = null;
      target.previewOffset = null;
      if (!this.rangeBelongsToRoot(target.range, root)) {
        this.reanchorToContinue(root, target.range, preferredOffset);
      }
    }

    const range = target.range;
    // If the user deliberately moved the caret inside the SAME editor during
    // dictation, honor the live selection; otherwise restore the captured one.
    // The live range can itself be stale (site re-render): a throw here must
    // NOT escape and silently drop the final transcript — fall back to the
    // captured range and let the re-anchor + retry below handle it.
    const selection = window.getSelection();
    if (selection && this.shouldFollowLiveSelection(root) && selection.rangeCount > 0) {
      try {
        const live = selection.getRangeAt(0);
        if (root.contains(live.commonAncestorContainer) && this.shouldAdoptLiveCaret(root, live)) {
          range.setStart(live.startContainer, live.startOffset);
          range.setEnd(live.endContainer, live.endOffset);
          this.noteUserCaretAdopted();
        }
      } catch {
        /* stale live selection — use the captured range instead */
      }
    }

    // Site adapters may re-anchor the range before the mutation (e.g. Keep's
    // Docs-style editors only keep content inside their canonical <p>).
    // A rebuild can leave the stored range detached entirely — fall back to
    // the remembered dictation position instead of the end-of-content retry.
    if (!this.rangeBelongsToRoot(range, root)) {
      this.reanchorToContinue(root, range);
    }
    // A rebuild that replaced the nodes around the caret silently remapped the
    // tracked range (usually to the start of the editor) while it still
    // "belongs" to this root: without this the next phrase is typed before the
    // text already in the field, and the user's next Enter cuts that line in
    // the wrong place.
    this.healRemappedRange(target, root);
    this.anchorInsertionRange(root, range);

    // The browser's speech engine prefixes utterances with a space; drop it
    // when inserting at the very beginning of the editor's content.
    const safeText = this.isAtVeryStart(root, range) ? text.replace(/^ +/, '') : text;

    const inserted = this.insertAtRange(root, range, safeText);
    if (!inserted.ok) return { ok: false, reason: inserted.reason };
    if (inserted.last) {
      // Collapse the caret right after the inserted content and keep the saved
      // range for the next phrase of this dictation session (spec §10, §14).
      this.finishAfterInsert(target, range, inserted.last);
    }
    this.notifyChange(target, safeText);
    return { ok: true };
  }

  replaceText(target: InsertionTarget, text: string, previousText: string): AdapterValidation {
    if (target.type !== 'contenteditable') return { ok: false, reason: 'not a contenteditable target' };
    const check = this.validateTarget(target);
    if (!check.ok) return check;
    const root = target.element;
    const range = target.range;
    if (!this.rangeBelongsToRoot(range, root)) {
      this.reanchorToContinue(root, range);
    }
    if (!this.rangeBelongsToRoot(range, root)) {
      return { ok: false, reason: 'captured range no longer belongs to the element' };
    }

    const endOffset = this.textOffsetBefore(root, range.startContainer, range.startOffset);
    const expected = previousText.trim();
    if (expected.length === 0) return { ok: false, reason: 'previous transcript is empty' };
    let startOffset = endOffset - previousText.length;
    let start = startOffset >= 0 ? this.locateTextOffset(root, startOffset) : null;
    let end = this.locateTextOffset(root, endOffset);
    let matches =
      startOffset >= 0 &&
      start !== null &&
      end !== null &&
      this.previewDataMatches((root.textContent ?? '').slice(startOffset, endOffset).trim(), expected);
    if (!matches) {
      startOffset = endOffset - expected.length;
      start = startOffset >= 0 ? this.locateTextOffset(root, startOffset) : null;
      end = this.locateTextOffset(root, endOffset);
      matches =
        startOffset >= 0 &&
        start !== null &&
        end !== null &&
        this.previewDataMatches((root.textContent ?? '').slice(startOffset, endOffset).trim(), expected);
    }
    if (!matches || !start || !end) {
      return { ok: false, reason: 'previous transcript is no longer at the caret' };
    }
    if (this.blockForNode(root, range.startContainer) !== this.blockForNode(root, start.startContainer)) {
      return { ok: false, reason: 'previous transcript is no longer at the caret' };
    }

    const probe = document.createRange();
    probe.setStart(start.startContainer, start.startOffset);
    probe.collapse(true);
    const safeText = this.isAtVeryStart(root, probe) ? text.replace(/^ +/, '') : text;
    const fragment = this.buildSafeFragment(safeText);
    const last = fragment.lastChild;
    try {
      const replacement = document.createRange();
      replacement.setStart(start.startContainer, start.startOffset);
      replacement.setEnd(end.startContainer, end.startOffset);
      replacement.deleteContents();
      replacement.insertNode(fragment);
      target.range = replacement.cloneRange();
      if (last) {
        target.range.setStartAfter(last);
        target.range.setEndAfter(last);
      } else {
        target.range.collapse(true);
      }
      if (this.shouldMoveSelectionAfterWrite(target)) {
        const selection = window.getSelection();
        if (selection) {
          selection.removeAllRanges();
          selection.addRange(target.range.cloneRange());
        }
      }
      this.rememberAnchor(root, target.range);
      target.previewNode = null;
      target.previewText = null;
      target.previewOffset = null;
      this.notifyChange(target, safeText);
      return { ok: true };
    } catch {
      return { ok: false, reason: 'replacement range is stale' };
    }
  }

  /**
   * Whether the live DOM selection may be followed for this write. Default:
   * only when the editor itself holds focus — following selections in an
   * unfocused editor would react to carets the user placed elsewhere. Site
   * adapters override this: Google Keep's combobox note body is
   * contenteditable="false" and does not show up as activeElement even while
   * the user is typing in it, so exact-equality gating made every manual
   * caret move (e.g. Shift+Enter) invisible to the insertion layer there.
   */
  protected shouldFollowLiveSelection(root: HTMLElement): boolean {
    return document.activeElement === root;
  }

  /**
   * Hook for site adapters: decide whether a live DOM selection may replace
   * the tracked caret. Default adopts genuine user carets but REJECTS the
   * degenerate element-edge caret that a site DOM rebuild produces: when a
   * site replaces the nodes around the caret, the browser silently remaps
   * the selection to (root, 0) — the very START of the editor (verified in
   * real Chrome/Edge). Adopting it made the next phrase (or preview) type at
   * the front of the existing text, then the tracked caret dragged it back —
   * the observed "caret jumps to the front, then back" on any rebuilding
   * site, not just Keep.
   *
   * A caret inside a Text node is always honored. A genuine user click at
   * the very start still lands inside a Text node in real browsers (verified:
   * a click on the first character reports (textNode, 0)), so only true
   * element-position carets are treated as rebuild artifacts. Site adapters
   * can override to tighten or relax this.
   */
  protected shouldAdoptLiveCaret(root: HTMLElement, live: Range): boolean {
    if (!live.collapsed) return true;
    return !this.isRebuildArtifactCaret(root, live);
  }

  /**
   * Whether a COLLAPSED caret is the degenerate element-edge position a site
   * DOM rebuild produces: when a site replaces the nodes around the caret,
   * the browser silently remaps the selection to (root, 0) — the very START
   * of the editor (verified in real Chrome/Edge). A caret inside a Text node
   * is never an artifact, and a genuine user click at the very start still
   * lands inside a Text node in real browsers (verified: a click on the first
   * character reports (textNode, 0)), so only true element-position carets
   * are treated as artifacts.
   *
   * Kept separate from shouldAdoptLiveCaret because the post-gesture caret
   * capture must keep accepting genuine user carets even when the write-time
   * adoption policy has gone conservative (after our own writes, the live
   * selection is treated as an echo, not as intent).
   */
  protected isRebuildArtifactCaret(root: HTMLElement, live: Range): boolean {
    if (live.startContainer.nodeType === Node.TEXT_NODE) return false;
    // A collapsed caret in an element position: only an artifact when it is
    // the degenerate (root, 0) / (firstChild, 0) edge of a rebuild.
    if (live.startContainer !== root) {
      // Element containers other than root are usually intermediate wrappers;
      // treat a child-index-0 edge as degenerate too, deeper positions as real.
      return live.startOffset === 0 && this.isEdgeOfRoot(root, live.startContainer);
    }
    return live.startOffset === 0;
  }

  /** True when `container` is root or its first descendant element chain. */
  private isEdgeOfRoot(root: HTMLElement, container: Node): boolean {
    if (container === root) return true;
    let current: Node | null = container;
    while (current && current !== root) {
      if (current.previousSibling) return false;
      current = current.parentNode;
    }
    return current === root;
  }

  /**
   * Hook for site adapters: bring the editor into focus before a final
   * commit. Default focuses unconditionally (previous behavior everywhere).
   */
  protected focusRootForInsert(root: HTMLElement): void {
    try {
      root.focus({ preventScroll: true });
    } catch {
      /* non-focusable is fine */
    }
  }

  /**
   * Hook for site adapters: re-anchor `range` immediately before a DOM
   * insertion/preview mutation. Default keeps the range as-is.
   */
  protected anchorInsertionRange(root: HTMLElement, range: Range): void {}

  /**
   * Deletes the range's contents and inserts `text` as safe nodes. Editors
   * that re-render mid-session can invalidate the captured boundary offsets
   * (IndexSizeError on deleteContents/insertNode) or point them at detached
   * nodes — in that case re-anchor and retry once instead of throwing: a
   * throw would skip the commit entirely, so recognition would keep
   * "inserting" into the void while the session looked healthy.
   *
   * The retry continues at the remembered dictation position (or the end of
   * content only when nothing is remembered). The previous retry anchored to
   * the END of content unconditionally, which is exactly the "cursor moves
   * behind the existing text" symptom on a mid-text caret.
   */
  private insertAtRange(
    root: HTMLElement,
    range: Range,
    text: string
  ): { ok: boolean; last: Node | null; reason?: string } {
    try {
      const fragment = this.buildSafeFragment(text);
      const last = fragment.lastChild;
      range.deleteContents();
      range.insertNode(fragment);
      return { ok: true, last };
    } catch {
      this.reanchorToContinue(root, range);
      try {
        const fragment = this.buildSafeFragment(text);
        const last = fragment.lastChild;
        range.deleteContents();
        range.insertNode(fragment);
        return { ok: true, last };
      } catch (error) {
        return {
          ok: false,
          last: null,
          reason: error instanceof Error ? error.message : 'range insertion failed',
        };
      }
    }
  }

  /** Collapse the caret after `last` and keep the saved range for the session. */
  protected finishAfterInsert(target: InsertionTarget, range: Range, last: Node): void {
    if (target.type !== 'contenteditable') return;
    range.setStartAfter(last);
    range.setEndAfter(last);
    target.range = range.cloneRange();
    this.rememberAnchor(target.element, target.range);
    if (this.shouldMoveSelectionAfterWrite(target)) {
      const selection = window.getSelection();
      if (selection) {
        selection.removeAllRanges();
        selection.addRange(range);
      }
    }
  }

  /**
   * Whether this write may move the VISIBLE selection. The tracked range and
   * the resume anchor are always updated; this only gates dragging the
   * user's caret. Site adapters veto when the user is editing and the write
   * could not be placed at their caret — a blind write must never yank the
   * caret away from where they are typing (observed on Google Keep: while
   * the user typed with a hot mic, engine results arriving mid-editing
   * dragged the caret back to the last dictation position, so Enter broke
   * the line at the wrong spot and Backspace lost its place).
   */
  protected shouldMoveSelectionAfterWrite(target: InsertionTarget): boolean {
    return true;
  }

  /**
   * Hook: the write just adopted the live DOM selection as its insertion
   * point — i.e. the placement IS the user's caret. Site adapters record
   * this so their visible-caret gates can allow the normal caret-following
   * behavior for this write; the base records it so healRemappedRange() leaves
   * that caret alone.
   */
  protected noteUserCaretAdopted(): void {
    this.userCaretAdoptedThisWrite = true;
  }

  /**
   * Finds the live preview so the final transcript can replace it: the
   * attached preview node, or — after a site DOM normalization detached it —
   * the exact previewed string verified in the editor's current text.
   * Whitespace-run differences are tolerated: sites like ChatGPT rewrite
   * regular spaces as non-breaking/other whitespace variants during
   * normalization, which would otherwise make the verification miss and the
   * final commit duplicate the previewed words.
   *
   * Attachment means "inside THIS editor root" (root.contains), NEVER bare
   * parentNode presence: when a site rebuild replaces whole subtrees (Google
   * Keep rebuilds entire <p> elements on every input sync), the old nodes
   * keep a non-null parentNode inside the DETACHED subtree. Treating that as
   * attached swaps the final transcript into the void while the visible DOM
   * keeps the stale preview — observed as duplicated/mixed-up words and a
   * caret that jumps to the start on Keep.
   */
  private locatePreview(
    root: HTMLElement,
    previewText: string | null,
    previewNode: Text | null,
    expectedOffset: number | null
  ): { node: Text | null; startContainer: Node; startOffset: number; endContainer: Node; endOffset: number } | null {
    if (previewNode && root.contains(previewNode)) {
      if (previewText !== null && this.previewDataMatches(previewNode.data, previewText)) {
        return {
          node: previewNode,
          startContainer: previewNode,
          startOffset: 0,
          endContainer: previewNode,
          endOffset: previewNode.length,
        };
      }
      if (previewText === null) return null;
    }
    if (!previewText) return null;

    // Whitespace-tolerant scan over the editor's text, anchored to the
    // preview's last known offset so repeated words elsewhere in the note
    // are never mistaken for the live preview.
    //
    // A reclaimed span is the only path in this adapter that DELETES text it
    // did not just write, so it requires a recorded offset to anchor it. With
    // no expectation there is nothing to reclaim *to*: the scan would settle
    // on the first word-boundary-safe occurrence of the same words anywhere
    // in the editor, and the final commit would wipe that unrelated text (the
    // reported "a sentence I already wrote disappears"). Callers fall through
    // to the anchored insert path, which only ever adds text.
    if (expectedOffset === null) return null;
    const pattern = this.buildPreviewMatcher(previewText);
    const match = this.findWhitespaceTolerant(root, pattern, expectedOffset);
    if (match) return { node: null, ...match };
    return null;
  }

  /** Regex matching the preview text with \s+-runs collapsed per position.
   *  Leading/trailing whitespace of the preview is preserved so the whole
   *  span (including the engine's padding space) is reclaimed. */
  private buildPreviewMatcher(previewText: string): RegExp {
    if (previewText.trim().length === 0) return /$^/;
    const escaped = previewText
      .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      .replace(/\s+/g, '\\s+');
    return new RegExp(escaped);
  }

  protected previewDataMatches(data: string, expected: string): boolean {
    if (data === expected) return true;
    const source = expected
      .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      .replace(/\s+/g, '\\s+');
    try {
      return new RegExp(`^(?:${source})$`).test(data);
    } catch {
      return false;
    }
  }

  /**
   * Searches root's text for `pattern`; returns the character span so it can
   * be mapped back to text nodes. When `expectedOffset` is known (the
   * preview's last recorded position), only occurrences NEAR it are
   * considered — the closest wins. Unbounded scanning let a stale preview
   * match words far away in the note (repeated phrases, edits that shifted
   * offsets) and the reclaim then DELETED that far-away span — observed as
   * previously dictated text vanishing. Sites preserve text across rebuilds,
   * so the true preview stays within a small window of its recorded offset.
   * Without an expectation the first match is used (previous behavior).
   */
  private hasSafePreviewBoundaries(root: HTMLElement, index: number, length: number): boolean {
    const start = this.locateTextOffset(root, index, true);
    const end = this.locateTextOffset(root, index + length);
    if (!start || !end || start.startContainer !== end.startContainer) return true;
    if (start.startContainer.nodeType !== Node.TEXT_NODE) return true;
    const text = start.startContainer.textContent ?? '';
    const isWord = (value: string): boolean => value.length > 0 && /[\p{L}\p{N}]/u.test(value);
    const before = start.startOffset > 0 ? text.charAt(start.startOffset - 1) : '';
    const after = end.startOffset < text.length ? text.charAt(end.startOffset) : '';
    return !(isWord(before) && isWord(text.charAt(start.startOffset))) &&
      !(isWord(text.charAt(end.startOffset - 1)) && isWord(after));
  }

  private findWhitespaceTolerant(
    root: HTMLElement,
    pattern: RegExp,
    expectedOffset: number | null
  ): { startContainer: Node; startOffset: number; endContainer: Node; endOffset: number } | null {
    const allText = root.textContent ?? '';
    const globalPattern = new RegExp(pattern.source, 'g');
    const matches = [...allText.matchAll(globalPattern)].filter((candidate) => {
      const index = candidate.index ?? 0;
      if (expectedOffset !== null && Math.abs(index - expectedOffset) <= PREVIEW_MATCH_OFFSET_TOLERANCE) {
        return true;
      }
      return this.hasSafePreviewBoundaries(root, index, candidate[0].length);
    });
    if (matches.length === 0) return null;
    let match = matches[0]!;
    if (expectedOffset !== null) {
      const near = matches.filter((candidate) => Math.abs((candidate.index ?? 0) - expectedOffset) <= RECLAIM_WINDOW_CHARS);
      if (near.length === 0) return null;
      match = near[0]!;
      for (const candidate of near) {
        if (Math.abs((candidate.index ?? 0) - expectedOffset) < Math.abs((match.index ?? 0) - expectedOffset)) {
          match = candidate;
        }
      }
    }
    const start = this.locateTextOffset(root, match.index ?? 0, true);
    const end = this.locateTextOffset(root, (match.index ?? 0) + match[0].length);
    return start && end
      ? { ...start, endContainer: end.startContainer, endOffset: end.startOffset }
      : null;
  }

  /** Maps a plain-text offset inside root to (text node, offset within it). Protected: site adapters relocate carets by offset after a rebuild. */
  protected locateTextOffset(root: HTMLElement, offset: number, forward = false): { startContainer: Node; startOffset: number } | null {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let remaining = offset;
    let node = walker.nextNode();
    while (node) {
      const length = node.textContent?.length ?? 0;
      const next = walker.nextNode();
      if (remaining < length || (remaining === length && (!forward || !next))) {
        return { startContainer: node, startOffset: remaining };
      }
      remaining -= length;
      node = next;
    }
    return null;
  }

  /**
   * Replaces the preview span (attached node, or verified text span) with the
   * final transcript and collapses the caret right after it (spec §14).
   */
  private replacePreviewRange(
    target: InsertionTarget,
    text: string,
    preview: { node: Text | null; startContainer: Node; startOffset: number; endContainer: Node; endOffset: number }
  ): AdapterValidation {
    if (target.type !== 'contenteditable') return { ok: false, reason: 'not a contenteditable target' };
    const root = target.element;
    const selection = window.getSelection();

    // Lead-space rule: trim when the preview sits at the very beginning of
    // the editor's content (mirrors the plain-insertion path).
    const probe = document.createRange();
    probe.setStart(preview.startContainer, preview.startOffset);
    probe.setEnd(preview.startContainer, preview.startOffset);
    const safeText = this.isAtVeryStart(root, probe) ? text.replace(/^ +/, '') : text;

    const fragment = this.buildSafeFragment(safeText);
    const lastInserted = fragment.lastChild;
    let replaced = false;

    try {
      if (preview.node && root.contains(preview.node) && preview.node.parentNode) {
        // Attached preview node → swap it out entirely (no leftover empty node).
        preview.node.parentNode.replaceChild(fragment, preview.node);
        replaced = true;
      } else if (preview.node) {
        // The node detached between locate and replace (or locate handed us
        // a node from another subtree) — fall through to the anchored
        // fallback instead of writing into the void.
        replaced = false;
      } else {
        // Reclaimed preview text inside a text node → delete exactly its span.
        const container = preview.startContainer;
        if (container.nodeType !== Node.TEXT_NODE) {
          // The span resolved to an element boundary: the exact deletion is no
          // longer provable, so this must NOT be reported as a successful
          // commit — that would drop the final transcript entirely. Continue
          // at the preview's anchor instead (additive, never destructive).
          target.previewNode = null;
          target.previewText = null;
          target.previewOffset = null;
          return this.insertAtEnd(target, safeText, null);
        }
        const wipe = document.createRange();
        wipe.setStart(container, preview.startOffset);
        wipe.setEnd(preview.endContainer, preview.endOffset);
        wipe.deleteContents();
        wipe.insertNode(fragment);
        replaced = true;
      }
    } catch {
      // The preview span went stale while committing (site re-render raced
      // the swap) — fall through to the anchored fallback instead of throwing
      // past the recognizer.
      replaced = false;
    }

    if (!replaced) {
      return this.insertAtEnd(
        target,
        safeText,
        this.textOffsetBefore(root, preview.startContainer, preview.startOffset)
      );
    }

    if (lastInserted) {
      target.range.setStartAfter(lastInserted);
      target.range.setEndAfter(lastInserted);
      if (this.shouldMoveSelectionAfterWrite(target) && selection) {
        selection.removeAllRanges();
        selection.addRange(target.range);
      }
    }
    this.rememberAnchor(root, target.range);
    target.previewNode = null;
    target.previewText = null;
    target.previewOffset = null;
    this.notifyChange(target, safeText);
    return { ok: true };
  }

  /**
   * Plain anchored insertion used as a safe fallback when the exact preview
   * span cannot be replaced: continue at the last known dictation position
   * (`anchorOffset` — where the preview sat — when known), falling back to
   * the remembered anchor and finally the end of the live content. Site
   * adapters refine the anchor, and preview tracking is dropped.
   */
  private insertAtEnd(target: InsertionTarget, text: string, anchorOffset?: number | null): AdapterValidation {
    if (target.type !== 'contenteditable') return { ok: false, reason: 'not a contenteditable target' };
    const root = target.element;
    const range = target.range;
    this.reanchorToContinue(root, range, anchorOffset ?? null);
    const inserted = this.insertAtRange(root, range, text);
    if (!inserted.ok) return { ok: false, reason: inserted.reason };
    if (inserted.last) this.finishAfterInsert(target, range, inserted.last);
    target.previewNode = null;
    target.previewText = null;
    target.previewOffset = null;
    this.notifyChange(target, text);
    return { ok: true };
  }

  /**
   * Live-dictation preview: insert a text node at the caret holding the
   * pending transcript. Repeated calls rewrite that same node in place —
   * nothing else in the editor moves — and insertText() swaps the node for
   * the final transcript (spec §14). Focus is never stolen for a preview.
   */
  previewText(target: InsertionTarget, text: string): AdapterValidation {
    if (target.type !== 'contenteditable') return { ok: false, reason: 'not a contenteditable target' };
    const check = this.validateTarget(target);
    if (!check.ok) return check;
    const root = target.element;
    this.userCaretAdoptedThisWrite = false;

    const existing = target.previewNode ?? null;
    // Re-check attachment at the moment of the write: a site re-render can
    // detach the node BETWEEN the validateTarget check above and this write.
    // Writing to a detached node silently "inserts" into the void while the
    // session looks healthy (Keep's Docs-style editors rebuild their <p> on
    // every input event, which is exactly how dictated text vanishes or
    // lands in two places at once). Attachment is root.contains — a node in
    // a detached subtree still has a non-null parentNode (see locatePreview).
    if (
      existing &&
      root.contains(existing) &&
      (target.previewText == null || this.previewDataMatches(existing.data, target.previewText))
    ) {
      const offset = this.textOffsetBefore(root, existing, 0);
      existing.data = this.flatten(offset === 0 ? text.replace(/^ +/, '') : text);
      target.previewText = existing.data;
      target.previewOffset = offset;
      this.finishAfterInsert(target, target.range, existing);
      this.notifyChange(target, target.previewText ?? undefined);
      return { ok: true };
    }
    if (existing) {
      // Detached by a site re-render — or the node's data diverged from the
      // recorded preview (the user typed into it): drop the node so the
      // reclaim logic below re-anchors onto the previewed WORDS instead of
      // blindly overwriting whatever the node holds now. Also re-anchor the
      // stored range: it may sit inside a detached subtree, and the next
      // plain mutation would insert into the void as a result. Continue at
      // the preview's recorded start (the caret the user actually had) — the
      // old blind end-of-content anchor dragged mid-note dictation behind all
      // the text whenever the reclaim missed.
      const preferredOffset = target.previewOffset ?? null;
      target.previewNode = null;
      this.reanchorToContinue(root, target.range, preferredOffset);
    }

    const selection = window.getSelection();
    const range = target.range;
    // Follow the live caret only when the editor plausibly holds the user's
    // attention (see shouldFollowLiveSelection); a transient preview must
    // never pull focus away from other UI.
    // Guarded: a stale live selection must not throw and drop the preview.
    if (selection && this.shouldFollowLiveSelection(root) && selection.rangeCount > 0) {
      try {
        const live = selection.getRangeAt(0);
        if (root.contains(live.commonAncestorContainer) && this.shouldAdoptLiveCaret(root, live)) {
          range.setStart(live.startContainer, live.startOffset);
          range.setEnd(live.endContainer, live.endOffset);
          this.noteUserCaretAdopted();
        }
      } catch {
        /* stale live selection — use the stored range instead */
      }
    }

    // Site adapters may re-anchor before the preview mutation (e.g. Keep's
    // Docs-style editors only keep content inside their canonical <p>).
    // A rebuild can detach the stored range entirely — fall back to the
    // remembered dictation position instead of the end-of-content retry.
    if (!this.rangeBelongsToRoot(range, root)) {
      this.reanchorToContinue(root, range);
    }
    this.healRemappedRange(target, root);
    this.anchorInsertionRange(root, range);

    // If a site normalization detached the previous preview but kept its
    // words, reclaim them so this preview REPLACES instead of appending.
    const previewLocation = this.locatePreview(root, target.previewText ?? null, null, target.previewOffset ?? null);
    if (previewLocation && !previewLocation.node) {
      range.setStart(previewLocation.startContainer, previewLocation.startOffset);
      range.setEnd(previewLocation.endContainer, previewLocation.endOffset);
    }
    target.previewText = null;
    target.previewOffset = null;

    const flat = this.flatten(this.isAtVeryStart(root, range) ? text.replace(/^ +/, '') : text);
    const inserted = this.insertAtRange(root, range, flat);
    if (!inserted.ok) return { ok: false, reason: inserted.reason };
    const node = inserted.last;
    if (!node) return { ok: true };
    target.previewNode = node instanceof Text ? node : null;
    target.previewText = node.textContent ?? '';
    target.previewOffset = this.textOffsetBefore(root, node, 0);

    this.finishAfterInsert(target, range, node);
    this.notifyChange(target, target.previewText ?? undefined);
    return { ok: true };
  }

  textBeforeCaret(target: InsertionTarget): string {
    if (target.type !== 'contenteditable') return '';
    const root = target.element;
    if (!root.isConnected) return '';
    const range = target.range.cloneRange();
    try {
      const preview = this.locatePreview(root, target.previewText ?? null, target.previewNode ?? null, target.previewOffset ?? null);
      if (preview) {
        range.setStart(preview.startContainer, preview.startOffset);
        range.collapse(true);
        } else {
          const selection = window.getSelection();
          if (this.shouldFollowLiveSelection(root) && selection?.rangeCount) {
          const live = selection.getRangeAt(0);
          if (root.contains(live.commonAncestorContainer) && this.shouldAdoptLiveCaret(root, live)) {
            range.setStart(live.startContainer, live.startOffset);
            range.collapse(true);
          }
        }
      }
      if (!this.rangeBelongsToRoot(range, root)) return '';
      const container = range.startContainer instanceof Element ? range.startContainer : range.startContainer.parentElement;
      const block = container?.closest('p,div,li');
      let scope = block instanceof HTMLElement && root.contains(block) ? block : root;
      if (scope === root && range.startContainer === root && range.startOffset > 0) {
        const prev = root.childNodes[range.startOffset - 1];
        const prevElement = prev instanceof Element ? prev : prev?.parentElement;
        if (prevElement && root.contains(prevElement) && prevElement.closest('p,div,li')) {
          scope = prevElement.closest('p,div,li') as HTMLElement;
        }
      }
      const probe = document.createRange();
      probe.selectNodeContents(scope);
      probe.setEnd(range.startContainer, range.startOffset);
      const fragment = probe.cloneContents();
      const walker = document.createTreeWalker(fragment, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);
      let text = '';
      let node = walker.nextNode();
      while (node) {
        if (node.nodeType === Node.TEXT_NODE) text += node.textContent;
        else if (node instanceof HTMLBRElement) text += '\n';
        node = walker.nextNode();
      }
      return text.slice(-12);
    } catch {
      return '';
    }
  }

  protected notifyChange(target: Extract<InsertionTarget, { type: 'contenteditable' }>, data?: string): void {
    try {
      target.element.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data }));
    } catch {
      target.element.dispatchEvent(new Event('input', { bubbles: true }));
    }
  }

  resetPreview(target: InsertionTarget): void {
    if (target.type !== 'contenteditable') return;
    target.previewNode = null;
    target.previewText = null;
    target.previewOffset = null;
  }

  // ---- helpers ----

  /** A single preview text node cannot hold <br>; newlines become spaces. */
  private flatten(text: string): string {
    return text.replace(/\r?\n+/g, ' ');
  }

  /**
   * Plain-text offset (in characters) of a position inside root's content.
   * Computed in the textContent coordinate space — the SAME space the
   * reclaim matcher (findWhitespaceTolerant) searches. Range.toString() is
   * deliberately NOT used: real browsers may render line breaks for <br> /
   * block boundaries in a Range string that textContent does not contain, so
   * a toString-based offset skews on multiline editors and the reclaim can
   * hit the WRONG repeated word, dragging the caret into the wrong paragraph
   * (observed on Keep once notes grow past one line).
   *
   * Handles both text-node positions (carets in text) and element positions
   * ((parent, childIndex) as produced by setStartAfter / selectNodeContents /
   * browser selection adjustments). Offsets past the end are clamped — the
   * browser can leave stale child indexes behind after a rebuild.
   *
   * Protected so site adapters can snapshot caret intent as an offset (which
   * survives DOM rebuilds that silently remap Range objects).
   */
  protected textOffsetBefore(root: HTMLElement, container: Node, offset: number): number {
    if (container.nodeType === Node.TEXT_NODE) {
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      let total = 0;
      let node = walker.nextNode();
      while (node) {
        if (node === container) {
          return total + Math.max(0, Math.min(offset, node.textContent?.length ?? 0));
        }
        total += node.textContent?.length ?? 0;
        node = walker.nextNode();
      }
      return total;
    }
    if (container instanceof Element && root.contains(container)) {
      const start = this.offsetOfNodeStart(root, container) ?? 0;
      const kids = container.childNodes;
      const n = Math.max(0, Math.min(offset, kids.length));
      let inner = 0;
      for (let i = 0; i < n; i++) inner += kids[i]!.textContent?.length ?? 0;
      return start + inner;
    }
    // Detached or unknown container: best effort = end of current text.
    return root.textContent?.length ?? 0;
  }

  /**
   * textContent offset of the START of `node` (a descendant of root):
   * the length of all root text that precedes it in document order.
   */
  private offsetOfNodeStart(root: HTMLElement, node: Node): number | null {
    if (!root.contains(node)) return null;
    if (node === root) return 0;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let total = 0;
    let current = walker.nextNode();
    while (current) {
      if (current === node) return total;
      const rel = node.compareDocumentPosition(current);
      if ((rel & Node.DOCUMENT_POSITION_FOLLOWING) !== 0) {
        // This text comes after `node` — node's start is right here.
        return total;
      }
      total += current.textContent?.length ?? 0;
      current = walker.nextNode();
    }
    return total;
  }

  /**
   * Resolves the editable root for `element`, or null when it is not
   * editable. Protected so site adapters can extend the definition of
   * "editable" (e.g. Google Keep's non-contenteditable combobox editor)
   * while reusing capture/insert/preview logic unchanged.
   */
  protected findRoot(element: Element): HTMLElement | null {
    if (!(element instanceof HTMLElement)) return null;
    if (element.isContentEditable) {
      const root = element.closest(CONTENTEDITABLE_SELECTOR);
      return root instanceof HTMLElement ? root : element;
    }
    // jsdom (unit tests) never computes isContentEditable, so also honor the
    // explicit contenteditable-attribute inheritance browsers use. In real
    // Chrome this branch is unreachable for genuinely editable elements —
    // there isContentEditable is always true when an editable root exists —
    // and contenteditable="false" correctly resolves to null.
    let current: HTMLElement | null = element;
    while (current) {
      const value = current.getAttribute('contenteditable');
      if (value !== null) {
        return value === 'false' ? null : current;
      }
      current = current.parentElement;
    }
    return null;
  }

  private blockForNode(root: HTMLElement, node: Node): HTMLElement {
    let current: Node | null = node.nodeType === Node.TEXT_NODE ? node.parentNode : node;
    while (current && current !== root) {
      if (current instanceof HTMLElement && /^(P|DIV|LI)$/.test(current.tagName)) return current;
      current = current.parentNode;
    }
    return root;
  }

  private rangeBelongsToRoot(range: Range, root: HTMLElement): boolean {
    return root.contains(range.startContainer) && root.contains(range.endContainer);
  }

  /**
   * True when the range sits at the very beginning of the editor's content.
   * Computed in the same textContent coordinate space as textOffsetBefore —
   * Range.toString() may report line breaks for <br>/block boundaries that
   * textContent does not contain, which would misjudge the very-start case
   * on multiline editors (see textOffsetBefore for the full rationale).
   */
  protected isAtVeryStart(root: HTMLElement, range: Range): boolean {
    if ((root.textContent ?? '').length === 0) return true;
    // The start of any block (paragraph / list item) counts as a very start:
    // the speech engine pads every utterance with a space, and keeping it at
    // the start of a new line would indent each line of a multi-line note.
    const container =
      range.startContainer instanceof Element ? range.startContainer : range.startContainer.parentElement;
    const block = container?.closest('p,div,li');
    const scope = block instanceof HTMLElement && root.contains(block) ? block : root;
    if ((scope.textContent ?? '').length === 0) return true;
    try {
      return this.textOffsetBefore(scope, range.startContainer, range.startOffset) === 0;
    } catch {
      return false;
    }
  }

  /** Build a DocumentFragment of text nodes and <br> — no HTML parsing. */
  protected buildSafeFragment(text: string): DocumentFragment {
    const fragment = document.createDocumentFragment();
    const lines = text.replace(/^\r?\n+|\r?\n+$/g, '').split(/\r?\n/);
    lines.forEach((line, index) => {
      if (index > 0) fragment.appendChild(document.createElement('br'));
      if (line.length > 0) fragment.appendChild(document.createTextNode(line));
    });
    return fragment;
  }
}
