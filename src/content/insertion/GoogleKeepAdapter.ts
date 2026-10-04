import type { InsertionTarget } from '../../shared/types';
import { ContentEditableAdapter } from './ContentEditableAdapter';
import type { AdapterValidation } from './InputAdapter';

/**
 * Site adapter for Google Keep (keep.google.com) — spec §43.
 *
 * What an inspection of Keep's app (closed-source, Closure-compiled "Wizy"
 * editor) tells us about its DOM, and how this adapter reacts:
 *
 * - Text entry comes in two shapes. The note body is a Docs-style editor
 *   root: `role="combobox" contenteditable="false" aria-autocomplete="list"`
 *   wrapping the note's paragraphs — NOT a contenteditable div, so the
 *   generic scan rejects it and this adapter promotes it (see findRoot).
 *   The note title and checklist items remain plain `contenteditable="true"`
 *   divs with `role="textbox"`, which the generic adapter already covers.
 * - Keep SAVES by listening to editor `input` events. Programmatic DOM
 *   insertion does NOT fire input events natively, so without this adapter
 *   dictated text would render but never sync — it vanishes when the note
 *   closes. Every mutation here is followed by a bubbling `input` event.
 * - Keep re-normalizes its editor DOM while you type (list items, div lines),
 *   which can detach the captured caret Range mid-session. Instead of failing
 *   with insert-failed, this adapter re-anchors the range to the live caret
 *   (or end of content) as long as the same editor element is still connected
 *   and editable.
 *
 * Class names in Keep are compile-time generated and rotate, so the adapter
 * keys off stable facts only: hostname + ARIA roles + contenteditable state.
 */
export function isKeepHost(hostname: string): boolean {
  return hostname === 'keep.google.com' || hostname.endsWith('.keep.google.com');
}

/**
 * Keep's note-body editor (Docs-style "Wizy" root): a div that is NOT itself
 * contenteditable — it is `role="combobox" contenteditable="false"` with
 * `aria-autocomplete="list"` and hosts an inner `contenteditable="false"`
 * document layer. The caret lives inside it and typing works, which plain
 * contenteditable detection misses. Checklist items / titles keep using
 * regular `contenteditable="true"` textbox divs.
 */
function isKeepComboboxEditor(element: Element): boolean {
  return (
    element.getAttribute('role') === 'combobox' &&
    element.getAttribute('contenteditable') === 'false' &&
    element.getAttribute('aria-autocomplete') === 'list'
  );
}

type CaretSnapshot = {
  offset: number;
  container: Node;
  index: number;
  before: Node | null;
  after: Node | null;
  anchor: Node | null;
};

/**
 * The user's caret as of their latest gesture, anchored three ways so it
 * survives Keep's rebuilds: the exact (container, index) for immediate use,
 * a (block index, offset within block) pair — Keep's rebuilds replace whole
 * <p> elements but preserve their count, order, and text, so the k-th <p>
 * maps back to the same line after a rebuild — and the global textContent
 * offset as the last resort. Only a (container, offset) form can
 * distinguish the START of a new empty line from the END of the previous
 * one (both are the same textContent offset after a manual line break).
 */
type UserCaretRecord = {
  root: HTMLElement;
  container: Node;
  index: number;
  blockIndex: number;
  blockOffset: number;
  offset: number;
  /**
   * True when the captured position sits immediately after a <br> (a soft
   * Shift+Enter line start): its blockOffset is then AMBIGUOUS — the end of
   * the previous line shares the same text offset — and only the after-break
   * resolution below may be used to restore it after a rebuild.
   */
  afterBreak: boolean;
  /**
   * How many <br> elements of the same block precede the captured position.
   * Disambiguates consecutive soft breaks ("text<br><br>"): both breaks share
   * one text offset, and the ordinal says which one the user moved behind.
   */
  breakOrdinal: number;
  /**
   * Monotonic ordering stamp (caretEventCounter) taken when the caret was
   * captured. A record captured AFTER our last write is fresh even when the
   * gesture that produced it is not "newer than the last write" anymore —
   * the selectionchange carrying the user's post-Enter caret routinely
   * arrives after the first blind write (Keep rebuilds first), and the
   * placement must still follow it.
   */
  stamp: number;
};

/** A caret position resolved back to (container, index). */
type CaretPosition = { container: Node; index: number };

/**
 * The delivered prefix of a still-live utterance that a manual gesture
 * handed to the user. See the `releasedPreview` field for the field roles.
 */
type ReleasedPreview = {
  element: HTMLElement;
  delivered: string;
  offset: number;
  tail: string;
  sawEnter: boolean;
  nodeHoldsRegion: boolean;
  manualBreaks: number;
};

type EnterGesture = {
  root: HTMLElement;
  sequence: number;
  fromOffset: number | null;
  fromBlockIndex: number;
};

export class GoogleKeepAdapter extends ContentEditableAdapter {
  private readonly host: string;
  private userGestureSequence = 0;
  private lastCaretWriteSequence = 0;
  private writeSequenceAtSchedule = 0;
  /**
   * Monotonic counter ordering caret captures against caret writes on one
   * timeline (see UserCaretRecord.stamp and lastCaretWriteStamp).
   */
  private caretEventCounter = 0;
  /** caretEventCounter value at our last caret-affecting write. */
  private lastCaretWriteStamp = 0;
  private userCaretRoot: HTMLElement | null = null;
  private latestTarget: InsertionTarget | null = null;
  /** Pending deferred caret re-assert (single slot — a newer op cancels it). */
  private pendingCaretReassertCancel: (() => void) | null = null;
  /** Armed guardian: the editor root + text offset the caret must hold. */
  private guard: {
    element: HTMLElement;
    offset: number;
    snapshot: CaretSnapshot | null;
    target: Extract<InsertionTarget, { type: 'contenteditable' }>;
  } | null = null;
  /** Observes the guarded editor so rebuild remaps are repaired pre-paint. */
  private readonly guardObserver: MutationObserver | null = null;
  /** Document-level selectionchange listener (null once disposed). */
  private guardSelectionChange: (() => void) | null = null;
  /** Document-level gesture listener (null once disposed or before setup). */
  private noteGesture: ((event: Event) => void) | null = null;
  /**
   * The editor root whose user gesture (keydown/pointerdown) has not had its
   * resulting caret captured yet. The browser moves the caret as part of the
   * gesture's default action — Enter's line break, a click, typed characters
   * — so the capture happens on the following selectionchange (or lazily at
   * the next write), never inside the keydown itself.
   */
  private awaitingUserCaret: HTMLElement | null = null;
  /**
   * The caretEventCounter value when the pending capture window was opened.
   * A capture examined after a WRITE has since happened (lastCaretWriteStamp
   * beyond this) can no longer be taken at face value: it may be the echo of
   * our own write — Keep's rebuild remapping the selection to the start of
   * the text — rather than the gesture's outcome, and it is filtered by
   * shape before being recorded (isPlausibleUserCaretShape).
   */
  private awaitingUserCaretStamp = 0;
  /**
   * The user's caret as of their latest gesture (see UserCaretRecord). This
   * is what lets dictation follow a manual Shift+Enter: the numeric
   * textContent anchors cannot distinguish the START of a new empty line
   * from the END of the previous one, and the exact nodes die on Keep's
   * rebuilds — the block anchor survives both.
   */
  private userCaret: UserCaretRecord | null = null;
  /**
   * True while the in-flight write's insertion point IS the user's caret
   * (rebased from the captured caret, adopted from the live selection, or
   * placed by the continuation-at-caret rule). When a write runs blind —
   * the user has gestured since our last write but their caret could not be
   * determined — this stays false and every visible-caret move is vetoed:
   * the text still lands at the tracked position, but the user's caret is
   * theirs (observed: engine results arriving mid-typing dragged the caret
   * to the last dictation position, so Enter broke the line at the wrong
   * spot and Backspace lost its place).
   */
  private writePlacedAtUserCaret = false;
  /**
   * Interim preview words a manual gesture handed to the user mid-utterance.
   * Chrome's continuous engine keeps emitting the SAME live result after the
   * gesture (and finalizes it later), so the span acts as a DELIVERED PREFIX
   * of that utterance: every later result for it — interim or final — may
   * only contribute the words it ADDS beyond the prefix, inserted right
   * after it. That is what keeps a phrase from being typed once per line
   * break (observed: "idea that" then "idea that idea that" … on every
   * Enter). Cleared when a genuinely different utterance arrives, on
   * recapture, and at session end.
   *
   * `tail` is the contiguous region that still belongs to the record
   * (verified before every reconciliation); `offset` is where that region
   * starts. Initially the tail IS the delivered prefix; once a continuation
   * has been placed at the user's post-Enter caret (nodeHoldsRegion), the
   * tail moves to the continuation text on the new line while `delivered`
   * keeps growing as the full utterance for continuationOf comparisons.
   */
  private releasedPreview: ReleasedPreview | null = null;
  /**
   * The last manual Enter (with or without Shift) inside an editor root and
   * the gesture sequence it occurred at. Unlike `releasedPreview.sawEnter`
   * this does not require a live preview to hand over: an Enter in the gap
   * between utterances (engine restart, before the next interim) also moves
   * the user's caret to a new line, and the next write must follow it even
   * though no prefix was released (see positionAfterManualBreak). Cleared by
   * any non-Enter gesture — after a click the live selection, not the break,
   * describes where the user is.
   */
  private lastEnterGesture: EnterGesture | null = null;

  /** Cancel the pending deferred caret re-assert, if any. */
  private cancelPendingCaretReassert(): void {
    this.pendingCaretReassertCancel?.();
  }

  constructor(host: string = typeof location !== 'undefined' ? location.hostname : '') {
    super();
    this.host = host;
    if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
      this.noteGesture = (event: Event): void => {
        if (event.composedPath().some((node) => node instanceof Element && node.id === '__voice-type-status-host')) return;
        const t = event.target instanceof Element ? event.target : null;
        if (t?.closest('#__voice-type-status-host')) return;
        this.userGestureSequence += 1;
        this.userCaretRoot = t ? this.findRoot(t) : null;
        this.disarmCaretGuardian();
        this.cancelPendingCaretReassert();
        this.releasePendingPreview();
        this.userCaret = null;
        if (this.userCaretRoot) {
          this.awaitingUserCaret = this.userCaretRoot;
          this.awaitingUserCaretStamp = this.caretEventCounter;
        }
        // An Enter (with or without Shift) is a manual line break: once the
        // browser applies it, the delivered prefix stays on the old line and
        // any continuation the utterance still owes belongs at the user's
        // new caret (see continuationAtUserCaret).
        const isEnterKey = event instanceof KeyboardEvent && event.key === 'Enter';
        let fromOffset: number | null = null;
        let fromBlockIndex = -1;
        if (isEnterKey && this.userCaretRoot) {
          const target = this.latestTarget;
          if (target?.type === 'contenteditable' && target.element === this.userCaretRoot) {
            try {
              fromOffset = this.textOffsetBefore(
                target.element,
                target.range.startContainer,
                target.range.startOffset
              );
              fromBlockIndex = this.blockIndexForPosition(target.element, target.range.startContainer);
              if (fromBlockIndex < 0) {
                const anchor = this.recallAnchor(target.element);
                const located = anchor === null ? null : this.locateTextOffset(target.element, anchor);
                if (located) {
                  fromOffset = anchor;
                  fromBlockIndex = this.blockIndexForPosition(target.element, located.startContainer);
                }
              }
            } catch {
              fromOffset = null;
              fromBlockIndex = -1;
            }
          }
        }
        if (isEnterKey && this.releasedPreview) {
          this.releasedPreview.sawEnter = true;
          // A SECOND manual break moves the user to yet another line. The
          // continuation region already lives on the previous one; without
          // re-arming, every later delta kept being rewritten there and
          // dragged the caret back across the break with it. The next delta
          // must again be placed at the caret the user just moved to.
          this.releasedPreview.nodeHoldsRegion = false;
          this.releasedPreview.manualBreaks += 1;
        }
        if (isEnterKey && this.userCaretRoot) {
          this.lastEnterGesture = {
            root: this.userCaretRoot,
            sequence: this.userGestureSequence,
            fromOffset,
            fromBlockIndex,
          };
        } else if (!isEnterKey) {
          this.lastEnterGesture = null;
        }
      };
      document.addEventListener('pointerdown', this.noteGesture, true);
      document.addEventListener('keydown', this.noteGesture, true);
      // Capture the user's post-gesture caret as soon as the browser moves
      // it (the default action of the gesture), before Keep's rebuild can
      // clear the selection. The caret repair backstop only acts while a
      // guardian is armed.
      this.guardSelectionChange = (): void => {
        if (this.awaitingUserCaret) this.captureUserCaret(this.awaitingUserCaret);
        if (this.guard) this.repairGuardedCaret();
      };
      document.addEventListener('selectionchange', this.guardSelectionChange);
    }
    // Fires for DOM rebuilds inside the guarded editor — the selection remap
    // a rebuild causes is repaired in the microtask after the mutation,
    // before the browser can paint the wrong caret position.
    if (typeof MutationObserver === 'function') {
      this.guardObserver = new MutationObserver(() => {
        this.repairGuardedCaret();
      });
    }
  }

  /**
   * Removes the document-level gesture listeners and any pending deferred
   * caret re-assert. Listeners die with the document anyway, but repeated
   * construction in one document (tests, future re-initialization) would
   * otherwise accumulate handlers that keep every instance alive.
   */
  dispose(): void {
    if (this.noteGesture) {
      document.removeEventListener('pointerdown', this.noteGesture, true);
      document.removeEventListener('keydown', this.noteGesture, true);
      this.noteGesture = null;
    }
    if (this.guardSelectionChange) {
      document.removeEventListener('selectionchange', this.guardSelectionChange);
      this.guardSelectionChange = null;
    }
    this.guard = null;
    this.guardObserver?.disconnect();
    this.cancelPendingCaretReassert();
    this.latestTarget = null;
    this.userCaretRoot = null;
    this.releasedPreview = null;
    this.awaitingUserCaret = null;
    this.userCaret = null;
    this.lastEnterGesture = null;
  }

  override canHandle(element: Element): boolean {
    return isKeepHost(this.host) && super.canHandle(element);
  }

  override captureTarget(element: Element): InsertionTarget | null {
    const previous = this.latestTarget;
    const target = super.captureTarget(element);
    this.latestTarget = target;
    if (target?.type === 'contenteditable' && !target.range.collapsed) {
      // A non-collapsed selection captured at start is never safe on Keep:
      // rebuilds remap selections across whole lines and the range would be
      // deleted outright by the first insertAtRange. Dictation continues at
      // the selection's start instead. Applies to EVERY Keep root — the
      // note body (combobox), the title, and checklist items alike: they
      // share one editor and one rebuild cycle, and a plain contenteditable
      // root used to keep the span, so the next write wiped the text it
      // spanned (reported: previously written text vanishes, then returns
      // when Keep's model re-renders it).
      try {
        target.range.setEnd(target.range.startContainer, target.range.startOffset);
      } catch {
        /* stale range — the write-time re-anchor handles it */
      }
    }
    // A language cycle (or any mid-session restart) re-captures the SAME
    // note. Wiping the utterance state here used to discard the delivered
    // prefix and the captured user caret — exactly the state the post-gesture
    // machinery relies on — so the first Shift+Enter after an EN→FA switch
    // lost its continuation and fell back to the previous line. Same-root
    // recapture keeps that state and counts as user intent (the user pressed
    // the switch), re-arming the caret capture for the live selection.
    const sameRoot =
      target?.type === 'contenteditable' &&
      previous?.type === 'contenteditable' &&
      previous.element === target.element;
    if (!sameRoot) {
      this.releasedPreview = null;
      this.awaitingUserCaret = null;
      this.userCaret = null;
      this.lastEnterGesture = null;
    } else {
      this.userGestureSequence += 1;
      this.userCaretRoot = target.element;
      this.awaitingUserCaret = target.element;
      this.awaitingUserCaretStamp = this.caretEventCounter;
    }
    if (target?.type === 'contenteditable') {
      // The captured position is now the deliberate insertion point (the
      // user's click / the live caret). Recording it as the anchor keeps the
      // rebuild-remap repair below from "correcting" the fresh capture back
      // to a position remembered by an older session.
      this.rememberAnchor(target.element, target.range);
    }
    return target;
  }

  /**
   * Follow the user when Keep moves them to a SIBLING combobox root
   * mid-session. In a checklist note every item is its own combobox root:
   * pressing Enter creates the next item and focus/selection move into it
   * while the captured target still points at the previous item, so writes
   * landed in the item the user just left (reported: after Enter the new
   * sentence kept appearing on the old line). Re-capture in place —
   * TargetManager holds this same target object — but only for a
   * combobox→combobox move: a plain contenteditable focused elsewhere is
   * the stale-capture case and must keep failing.
   */
  private retargetToMovedRoot(target: InsertionTarget): void {
    if (target.type !== 'contenteditable' || !isKeepComboboxEditor(target.element)) return;
    const selection = window.getSelection();
    const candidates: (Node | null)[] = [
      document.activeElement,
      selection?.anchorNode ?? null,
    ];
    for (const candidate of candidates) {
      if (!candidate || !candidate.isConnected || target.element.contains(candidate)) continue;
      const element = candidate instanceof Element ? candidate : candidate.parentElement;
      const root = element ? this.findRoot(element) : null;
      if (!root || root === target.element || !root.isConnected || !isKeepComboboxEditor(root)) {
        continue;
      }
      const captured = this.captureTarget(root);
      if (!captured || captured.type !== 'contenteditable' || captured.element !== root) return;
      target.element = captured.element;
      target.range = captured.range;
      target.previewNode = captured.previewNode;
      target.previewText = captured.previewText;
      target.previewOffset = captured.previewOffset;
      this.latestTarget = target;
      return;
    }
  }

  /**
   * Undo a rebuild's silent REMAP of the tracked range. Keep's renderer
   * replaces the editor's children on every input sync; when it removes the
   * nodes the tracked range points into, the browser re-anchors the range to
   * the nearest surviving boundary — in practice the START of the paragraph
   * or of the note. The remapped range still "belongs to" the root, so
   * validateTarget passes and nothing re-anchors it: the next phrase is then
   * spliced in before the text the user last dictated (the reported "cursor
   * jumps to the first character, then everything repeats there").
   *
   * The tracked range only ever moves through our own writes — each of which
   * also updates the remembered anchor to the SAME position — so a range
   * that disagrees with the anchor was moved by something else (a remap).
   * Re-anchor it to the remembered dictation position. Ranges placed at the
   * user's caret by the rebase are exempt, and a capture that deliberately
   * reset the range records that position as the anchor (see captureTarget).
   */
  protected healRebuildRemappedRange(
    target: Extract<InsertionTarget, { type: 'contenteditable' }>,
    root: HTMLElement
  ): void {
    if (this.writePlacedAtUserCaret) return;
    const range = target.range;
    if (!root.contains(range.startContainer) || !root.contains(range.endContainer)) return;
    let offset: number;
    try {
      offset = this.textOffsetBefore(root, range.startContainer, range.startOffset);
    } catch {
      return;
    }
    const remembered = this.recallAnchor(root);
    if (remembered === null || offset === remembered) return;
    // Re-align through the anchor's surrounding text, not the bare offset: a
    // rebuild that re-spaced or re-wrapped the note leaves the recorded offset
    // a few characters off, and adopting that position put the caret INSIDE a
    // word — so the user's next Enter split the line there and left its first
    // characters behind.
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
   * Resolve `text` against the delivered prefix of the pending utterance.
   * Returns the words the result may contribute ('' when it adds nothing)
   * plus the record, or null when there is no prefix, the utterance is
   * unrelated, or the user EDITED the owned tail region (it is theirs then —
   * reconcile no further). The record is cleared in those latter cases.
   */
  private resolveContinuation(
    target: Extract<InsertionTarget, { type: 'contenteditable' }>,
    text: string
  ): { continuation: string; released: ReleasedPreview } | null {
    const released = this.releasedPreviewFor(target);
    if (!released) {
      this.releasedPreview = null;
      return null;
    }
    const root = target.element;
    const end = this.spanEnd(released, root);
    // Whitespace-tolerant: Keep rewrites ordinary spaces to non-breaking
    // spaces in place (observed on checklist items) without changing the
    // region's length or words — an exact compare dropped the record and
    // the next final re-inserted the whole phrase beside the old one.
    if (!this.previewDataMatches((root.textContent ?? '').slice(released.offset, end), released.tail)) {
      // The user typed inside the owned region — the region is theirs.
      this.releasedPreview = null;
      return null;
    }
    const continuation = this.continuationOf(released.delivered, text);
    if (continuation === null) {
      this.releasedPreview = null;
      return null;
    }
    return { continuation, released };
  }

  /**
   * A live interim arrives. When a manual gesture already handed the pending
   * utterance's words to the user, this result may only contribute the words
   * it ADDS beyond them — otherwise every Enter would type the phrase again
   * (observed: "idea that", then "idea that idea that", …). A genuinely
   * different utterance clears the prefix and previews normally.
   */
  override previewText(target: InsertionTarget, text: string): AdapterValidation {
    if (target.type !== 'contenteditable') return super.previewText(target, text);
    this.prepareKeepTarget(target);
    const resolved = this.resolveContinuation(target, text);
    if (!resolved) return super.previewText(target, text);
    if (resolved.continuation.length === 0) return { ok: true };
    return this.showContinuation(target, resolved.released, resolved.continuation);
  }

  /**
   * Hand the pending interim preview to the user: its words stay in the note
   * (already synced by the preview's input event) and tracking drops, so the
   * user's next keystroke can't collide with a preview node we still own.
   * The words become the delivered prefix of the still-live utterance.
   * When a prefix is already released for this utterance (a continuation may
   * live on another line after a manual Enter), the record is KEPT — the
   * preview node only ever held that utterance's latest delta, so re-reading
   * it would shrink the prefix back to the delta and lose the utterance.
   */
  private releasePendingPreview(): void {
    const target = this.latestTarget;
    if (!target || target.type !== 'contenteditable') return;
    const element = target.element;
    if (!element.isConnected) return;
    const delivered = target.previewText ?? null;
    const offset = target.previewOffset ?? null;
    if (!delivered || delivered.trim().length === 0 || offset === null) return;
    const currentText = element.textContent ?? '';
    const currentSlice = currentText.slice(offset, offset + delivered.length);
    if (!this.previewDataMatches(currentSlice, delivered)) {
      target.previewNode = null;
      target.previewText = null;
      target.previewOffset = null;
      return;
    }
    // The user may have typed into the preview node (a period merged into
    // it); leave the node and its data untouched so their characters survive.
    target.previewNode = null;
    target.previewText = null;
    target.previewOffset = null;
    if (this.releasedPreview && this.releasedPreview.element === element) return;
    this.releasedPreview = {
      element,
      delivered,
      offset,
      tail: delivered,
      sawEnter: false,
      nodeHoldsRegion: false,
      manualBreaks: 0,
    };
  }

  /** The released prefix, only when it belongs to this target's editor. */
  private releasedPreviewFor(
    target: Extract<InsertionTarget, { type: 'contenteditable' }>
  ): ReleasedPreview | null {
    const released = this.releasedPreview;
    if (!released || released.element !== target.element || !target.element.isConnected) return null;
    return released;
  }

  /** End of the owned tail region inside `root`, as a textContent offset. */
  private spanEnd(released: ReleasedPreview, root: HTMLElement): number {
    return Math.min(released.offset + released.tail.length, (root.textContent ?? '').length);
  }

  /**
   * Words `text` contributes beyond the already-delivered `delivered` prefix:
   * '' when it adds nothing (an exact repeat, or a revision down of words
   * already delivered), the tail when it extends it, null for a different
   * utterance.
   */
  private continuationOf(delivered: string, text: string): string | null {
    const deliveredTrim = delivered.trim();
    const incoming = text.trim();
    if (incoming.length === 0) return null;
    if (incoming === deliveredTrim) return '';
    if (incoming.startsWith(deliveredTrim)) return incoming.slice(deliveredTrim.length);
    if (deliveredTrim.startsWith(incoming)) return '';
    return null;
  }

  /** The delivered utterance text after a continuation lands on a new line. */
  private joinDelivered(delivered: string, continuation: string): string {
    return `${delivered.trim()} ${continuation.trim()}`;
  }

  /**
   * The captured caret to place a continuation at: only when the user broke
   * the line with Enter AFTER the prefix was released, the delta is new
   * words (whitespace-led — mid-word completions like "فار" → "فارسی" must
   * finish the word where it started), the utterance has not already been
   * re-anchored past the break, and the capture still resolves.
   */
  private continuationAtUserCaret(released: ReleasedPreview, continuation: string): CaretPosition | null {
    if (!released.sawEnter || released.nodeHoldsRegion) return null;
    if (continuation.length === 0 || !/^\s/.test(continuation)) return null;
    const captured = this.userCaretFor(released.element);
    if (captured) return captured;
    // The caret capture missed the post-Enter position (Keep clears the
    // selection on rebuilds): infer it from the break that follows the
    // delivered prefix instead of gluing the continuation to the old line.
    // At least one break is always crossed: sawEnter is set only by a real
    // Enter, and returning the pre-break position here would place the words
    // on the previous line while claiming the placement IS the user's caret —
    // the visible caret would follow them back across the break, so the next
    // Enter split the previous line instead of the new one.
    if (this.enterGestureFresh(released.element)) {
      return this.inferPositionAfterManualBreaks(
        released.element,
        [this.lastEnterGesture?.fromOffset, this.spanEnd(released, released.element)],
        Math.max(1, released.manualBreaks)
      );
    }
    return null;
  }

  /**
   * Insert a continuation delta at the captured user caret. Returns the
   * placed node, its textContent offset, and the text actually inserted
   * (leading whitespace is dropped at the very start of a block — same rule
   * as the plain paths — so the region text recorded for later verification
   * matches the DOM).
   */
  private insertContinuationAtCaret(
    target: Extract<InsertionTarget, { type: 'contenteditable' }>,
    root: HTMLElement,
    position: CaretPosition,
    continuation: string
  ): { node: Text | null; offset: number; tail: string } | null {
    try {
      const range = document.createRange();
      range.setStart(position.container, position.index);
      range.collapse(true);
      // A post-Enter caret can be an element position on the combobox root
      // (between <p>s). Inserting there creates a bare text child Keep drops
      // on the next sync — retarget into the block that position denotes
      // (the <p> at that child index), falling back to the shared guard.
      if (
        position.container instanceof Element &&
        (position.container === root || !this.canonicalParagraph(root, position.container))
      ) {
        const next = position.container.childNodes[position.index];
        const prev = position.container.childNodes[position.index - 1];
        const block =
          next instanceof HTMLParagraphElement && root.contains(next)
            ? { node: next, offset: 0 }
            : prev instanceof HTMLParagraphElement && root.contains(prev)
              ? { node: prev, offset: prev.childNodes.length }
              : null;
        if (block) {
          range.setStart(block.node, block.offset);
          range.collapse(true);
        } else {
          this.anchorInsertionRange(root, range);
        }
      } else {
        this.anchorInsertionRange(root, range);
      }
      const safeText = this.isAtVeryStart(root, range) ? continuation.replace(/^ +/, '') : continuation;
      const fragment = this.buildSafeFragment(safeText);
      // The region text must be read BEFORE the insertion: insertNode moves
      // the fragment's children into the document, leaving textContent ""
      // behind — recording that as the tail made every later delta REPLACE
      // the words just placed (they vanished) instead of growing them, and
      // made the region verification vacuously pass.
      const tail = fragment.textContent ?? safeText;
      const last = fragment.lastChild;
      range.insertNode(fragment);
      this.writePlacedAtUserCaret = true;
      if (last) this.finishAfterInsert(target, range, last);
      const node = last instanceof Text ? last : null;
      return {
        node,
        offset: node ? this.textOffsetBefore(root, node, 0) : this.textOffsetBefore(root, position.container, position.index),
        tail,
      };
    } catch {
      return null;
    }
  }

  /**
   * Collapse `target.range` at a textContent offset and record it as the
   * resume anchor (with the normal visible-selection rules). Used by the
   * continuation commit paths that place words without a tracked node: the
   * next utterance must continue AFTER the committed words, not at the
   * pre-continuation position (the observed "new utterance goes back to the
   * previous line" after a continuation had landed correctly).
   */
  private anchorAtOffset(
    target: Extract<InsertionTarget, { type: 'contenteditable' }>,
    root: HTMLElement,
    offset: number
  ): void {
    const at = this.locateTextOffset(root, offset, true);
    if (!at) return;
    try {
      target.range.setStart(at.startContainer, at.startOffset);
      target.range.setEnd(at.startContainer, at.startOffset);
    } catch {
      return;
    }
    this.rememberAnchor(root, target.range);
    if (this.shouldMoveSelectionAfterWrite(target)) {
      try {
        const selection = window.getSelection();
        if (selection) {
          selection.removeAllRanges();
          selection.addRange(target.range.cloneRange());
        }
      } catch {
        /* best effort */
      }
    }
  }

  /**
   * Show the continuation right after the delivered prefix — or, when the
   * user has moved to a new line mid-utterance (manual Enter + a caret we
   * captured), at that caret: the words were spoken after the break and the
   * user expects them on the line they moved to. The same node is updated as
   * the utterance grows. Every write goes through notifyChange so the
   * sequence/stamp bookkeeping and the caret repair chain run exactly as they
   * do for a plain write — without them Keep's post-sync rebuild remapped the
   * caret to the editor start and nothing repaired it (reported: cursor to
   * the start of the line after Enter). The restore's own gates keep a blind
   * write from yanking the caret while the user is editing.
   */
  private showContinuation(
    target: Extract<InsertionTarget, { type: 'contenteditable' }>,
    released: ReleasedPreview,
    continuation: string
  ): AdapterValidation {
    const root = target.element;
    const end = this.spanEnd(released, root);
    const existing = target.previewNode;
    if (
      existing &&
      root.contains(existing) &&
      (released.nodeHoldsRegion
        ? this.previewDataMatches(existing.data, released.tail)
        : target.previewText == null || this.previewDataMatches(existing.data, target.previewText))
    ) {
      // Once the region lives on the new line, the tracked node holds the
      // whole tail; before that it only holds the delta after the prefix.
      const fullTail = released.nodeHoldsRegion ? released.tail + continuation : continuation;
      existing.data = fullTail;
      target.previewText = existing.data;
      target.previewOffset = this.textOffsetBefore(root, existing, 0);
      if (released.nodeHoldsRegion) {
        this.releasedPreview = { ...released, tail: fullTail };
      }
      this.notifyChange(target, target.previewText ?? undefined);
      return { ok: true };
    }
    // First continuation after the user's manual line break: place the new
    // words at the caret they moved to, not glued to the old line's prefix.
    const caret = this.continuationAtUserCaret(released, continuation);
    if (caret) {
      const placed = this.insertContinuationAtCaret(target, root, caret, continuation);
      if (placed) {
        // The snapshot's job is done — the record now owns the region on the
        // new line, and a later write must not re-anchor to the stale
        // post-Enter position.
        this.userCaret = null;
        this.releasedPreview = {
          element: root,
          delivered: this.joinDelivered(released.delivered, continuation),
          offset: placed.offset,
          tail: placed.tail,
          sawEnter: true,
          nodeHoldsRegion: true,
          manualBreaks: released.manualBreaks,
        };
        target.previewNode = placed.node;
        target.previewText = placed.tail;
        target.previewOffset = placed.offset;
        this.notifyChange(target, placed.tail);
        return { ok: true };
      }
    }
    if (released.nodeHoldsRegion) {
      // A Keep rebuild detached the tracked continuation node — rewrite the
      // region in place ONLY after proving the characters there are still
      // exactly the words we delivered. The bookmark is a GLOBAL textContent
      // offset, and Keep's renderer changes the editor's own text (it drops the
      // <br> elements buildSafeFragment forges and re-wraps lines), so those
      // offsets can come back pointing at the user's prose. Deleting on
      // unverified offsets is what ate whole sentences. Hard rule: this adapter
      // may only ever delete characters it wrote itself. When the check fails we
      // fall through to the non-destructive paths below instead of rewriting.
      const start = this.locateTextOffset(root, released.offset);
      const stop = this.locateTextOffset(root, end, true);
      let wipe: Range | null = null;
      if (start && stop) {
        try {
          const candidate = document.createRange();
          candidate.setStart(start.startContainer, start.startOffset);
          candidate.setEnd(stop.startContainer, stop.startOffset);
          if (this.previewDataMatches(candidate.toString(), released.tail)) {
            wipe = candidate;
          }
        } catch {
          wipe = null;
        }
      }
      if (wipe) {
        try {
          const fullTail = released.tail + continuation;
          const fragment = this.buildSafeFragment(fullTail);
          const last = fragment.lastChild;
          wipe.deleteContents();
          wipe.insertNode(fragment);
          this.releasedPreview = { ...released, tail: fullTail };
          const node = last instanceof Text ? last : null;
          if (node) {
            target.previewNode = node;
            target.previewText = fullTail;
            target.previewOffset = this.textOffsetBefore(root, node, 0);
          }
          if (last) this.finishAfterInsert(target, wipe, last);
          this.notifyChange(target, fullTail);
          return { ok: true };
        } catch {
          this.releasedPreview = null;
          return super.previewText(target, continuation);
        }
      }
      this.releasedPreview = null;
      return super.previewText(target, continuation);
    }
    // A Keep rebuild may have kept the continuation words as plain text after
    // the prefix — re-attach tracking to that text instead of re-inserting.
    if ((root.textContent ?? '').slice(end).startsWith(continuation)) {
      const at = this.locateTextOffset(root, end, true);
      if (at && at.startContainer instanceof Text) {
        target.previewNode = at.startContainer;
        target.previewText = continuation;
        target.previewOffset = end;
        // Adopt the already-present words as the owned region: the next
        // delta must compare against the FULL delivered utterance and land
        // after them. Leaving the record at the prefix made every later
        // delta insert before/beside the older continuation words.
        this.releasedPreview = {
          element: root,
          delivered: this.joinDelivered(released.delivered, continuation),
          offset: end,
          tail: continuation,
          sawEnter: released.sawEnter,
          nodeHoldsRegion: true,
          manualBreaks: released.manualBreaks,
        };
        this.notifyChange(target, continuation);
        return { ok: true };
      }
    }
    const at = this.locateTextOffset(root, end, true);
    if (!at) {
      this.releasedPreview = null;
      return super.previewText(target, continuation);
    }
    try {
      const node = document.createTextNode(continuation);
      const range = document.createRange();
      range.setStart(at.startContainer, at.startOffset);
      range.collapse(true);
      range.insertNode(node);
      target.previewNode = node;
      target.previewText = continuation;
      target.previewOffset = this.textOffsetBefore(root, node, 0);
      // Same record hand-off as the placement path above: the owned region
      // moves to the appended continuation so the utterance keeps growing
      // IN ORDER after it (the delivered prefix alone would re-order every
      // subsequent delta before the words already appended here).
      this.releasedPreview = {
        element: root,
        delivered: this.joinDelivered(released.delivered, continuation),
        offset: target.previewOffset,
        tail: continuation,
        sawEnter: released.sawEnter,
        nodeHoldsRegion: true,
        manualBreaks: released.manualBreaks,
      };
    } catch {
      this.releasedPreview = null;
      return super.previewText(target, continuation);
    }
    this.notifyChange(target, continuation);
    return { ok: true };
  }

  /**
   * Reconcile a delayed final with the words a gesture already delivered to
   * the user. The final may only contribute the words it ADDS beyond the
   * delivered prefix; repeating the prefix would type the phrase a second
   * time. Nothing is inserted when it adds nothing. A continuation preview
   * already holding (a prefix of) those words is grown to the final words in
   * place, so nothing is duplicated. A genuinely different utterance commits
   * normally at the user's caret.
   */
  override insertText(target: InsertionTarget, text: string): AdapterValidation {
    if (target.type !== 'contenteditable') return super.insertText(target, text);
    this.prepareKeepTarget(target);
    const resolved = this.resolveContinuation(target, text);
    if (!resolved) return super.insertText(target, text);
    const { continuation, released } = resolved;
    this.releasedPreview = null;
    const root = target.element;
    if (continuation.length === 0) {
      target.previewNode = null;
      target.previewText = null;
      target.previewOffset = null;
      return { ok: true };
    }
    // The final's delta is new words spoken after the user's manual line
    // break (no interim continuation was placed yet): put them at the caret
    // they moved to, not glued to the old line's prefix.
    const caret = this.continuationAtUserCaret(released, continuation);
    if (caret) {
      const placed = this.insertContinuationAtCaret(target, root, caret, continuation);
      if (placed) {
        this.userCaret = null;
        target.previewNode = null;
        target.previewText = null;
        target.previewOffset = null;
        this.notifyChange(target, placed.tail);
        return { ok: true };
      }
    }
    // The rebase above aimed at the user's post-Enter caret, but the
    // continuation is being placed at the delivered region instead (a
    // mid-word completion finishes the word on the old line; a detached node
    // is rewritten where it lives). Re-derive the flag from where the words
    // will actually land — on the user's new line only when the region
    // itself already lives there — otherwise the anchor updates below would
    // drag the visible caret back across the break.
    this.writePlacedAtUserCaret = released.nodeHoldsRegion;
    // The interim continuation node is a prefix of the final continuation:
    // grow it to the final words in place.
    const existing = target.previewNode;
    if (existing && root.contains(existing) && continuation.trim().startsWith(existing.data.trim())) {
      existing.data = released.nodeHoldsRegion ? released.tail + continuation : continuation;
      target.previewNode = null;
      target.previewText = null;
      target.previewOffset = null;
      // The anchor follows the committed words: the next utterance continues
      // AFTER them, not at the pre-continuation position.
      try {
        this.finishAfterInsert(target, document.createRange(), existing);
      } catch {
        /* anchor update is best-effort; the words are committed */
      }
      this.notifyChange(target, existing.data);
      return { ok: true };
    }
    const end = this.spanEnd(released, root);
    if ((root.textContent ?? '').slice(end, end + continuation.length) === continuation) {
      target.previewNode = null;
      target.previewText = null;
      target.previewOffset = null;
      this.anchorAtOffset(target, root, end + continuation.length);
      this.notifyChange(target, continuation);
      return { ok: true };
    }
    const insertAt = existing && root.contains(existing)
      ? this.textOffsetBefore(root, existing, existing.data.length)
      : end;
    const at = this.locateTextOffset(root, insertAt, true);
    if (!at) return super.insertText(target, continuation);
    let last: Node | null = null;
    const range = document.createRange();
    try {
      const fragment = this.buildSafeFragment(continuation);
      last = fragment.lastChild;
      range.setStart(at.startContainer, at.startOffset);
      range.collapse(true);
      range.insertNode(fragment);
    } catch {
      return super.insertText(target, continuation);
    }
    if (last) {
      try {
        this.finishAfterInsert(target, range, last);
      } catch {
        /* anchor update is best-effort; the words are committed */
      }
    }
    this.notifyChange(target, continuation);
    return { ok: true };
  }

  private prepareKeepTarget(target: Extract<InsertionTarget, { type: 'contenteditable' }>): void {
    this.retargetToMovedRoot(target);
    this.writePlacedAtUserCaret = false;
    if (this.awaitingUserCaret) this.captureUserCaret(this.awaitingUserCaret, true);
    // Heal BEFORE the rebase: the rebase's DOM-inferred fallback derives the
    // manual-break position from the tracked range's offset, and a range Keep's
    // rebuild silently remapped to the start of the note would make that
    // inference look for the break at offset 0 instead of after the dictated
    // words — so the next phrase landed on the previous line. Healing first
    // hands the rebase the true dictation position; when the rebase then moves
    // to the user's caret the healed value is simply superseded.
    this.healRebuildRemappedRange(target, target.element);
    this.rebaseToUserCaretIfTrusted(target);
  }

  override textBeforeCaret(target: InsertionTarget): string {
    if (target.type === 'contenteditable') this.prepareKeepTarget(target);
    return super.textBeforeCaret(target);
  }

  override replaceText(target: InsertionTarget, text: string, previousText: string): AdapterValidation {
    if (target.type !== 'contenteditable') return super.replaceText(target, text, previousText);
    this.prepareKeepTarget(target);
    const result = super.replaceText(target, text, previousText);
    if (result.ok) {
      this.releasedPreview = null;
      return result;
    }
    if (result.reason !== 'previous transcript is no longer at the caret') return result;
    const previousCore = previousText.trim();
    const currentCore = text.trim();
    if (!previousCore || !currentCore.startsWith(previousCore)) return result;
    const currentStart = text.indexOf(currentCore);
    const suffix = text.slice(currentStart + previousCore.length);
    if (suffix.trim().length === 0) return { ok: true };
    this.prepareKeepTarget(target);
    const fallback = super.insertText(target, suffix);
    if (fallback.ok) this.releasedPreview = null;
    return fallback;
  }

  /**
   * Promote Keep's combobox editor root (or anything editable nested in one)
   * to the insertion target so the note body can capture and insert.
   */
  protected override findRoot(element: Element): HTMLElement | null {
    if (!(element instanceof HTMLElement)) return null;
    if (isKeepComboboxEditor(element)) return element;
    const combobox = element.closest('[role="combobox"][contenteditable="false"][aria-autocomplete="list"]');
    if (combobox instanceof HTMLElement && isKeepComboboxEditor(combobox)) return combobox;
    return super.findRoot(element);
  }

  /**
   * Keep-specific target validation: re-anchor instead of failing when Keep's
   * editor normalized the DOM around our captured caret (spec §43).
   */
  override validateTarget(target: InsertionTarget): AdapterValidation {
    const base = super.validateTarget(target);
    if (base.ok || target.type !== 'contenteditable') return base;

    const root = target.element;
    if (!root.isConnected || !this.canHandle(root)) return base;

    // Keep rewrote the editor's children — the captured range points at
    // detached nodes. Re-anchor to the live caret when the browser still
    // exposes one inside this editor. (Keep's new Docs-style combobox body
    // often clears the DOM selection while re-rendering, so the next branch
    // is the one that actually rescues long sessions.) Guarded: a stale live
    // selection must not throw and mask the end-of-content rescue below.
    const selection = window.getSelection();
    if (selection && selection.rangeCount > 0) {
      try {
        const live = selection.getRangeAt(0);
        const focusOk = document.activeElement === root || root.contains(document.activeElement);
        if (
          focusOk &&
          root.contains(live.commonAncestorContainer) &&
          this.shouldAdoptLiveCaret(root, live)
        ) {
          target.range.setStart(live.startContainer, live.startOffset);
          target.range.setEnd(live.endContainer, live.endOffset);
          return { ok: true };
        }
      } catch {
        /* stale live selection — fall through to the end-of-content rescue */
      }
    }

    // Live caret unavailable but the editor element itself survived
    // (still connected, still Keep's editor): fall back to the remembered
    // dictation position — text offsets survive Keep's rebuilds, which
    // detach Range objects — instead of the blind END OF CONTENT that used
    // to drag mid-note dictation behind all the text. The end of content
    // remains the fallback when nothing is remembered. Appending after a
    // re-render is far better than dropping every remaining phrase. The
    // Docs-style combobox body accepts this unconditionally — Keep manages
    // its own focus/selection while re-rendering, and leaving the note
    // unmounts the editor (the isConnected check above). The legacy textbox
    // keeps its old contract: only while it still holds focus.
    const focusedHere = document.activeElement === root || root.contains(document.activeElement);
    if (!isKeepComboboxEditor(root) && !focusedHere) return base;
    this.reanchorToContinue(root, target.range);
    return { ok: true };
  }

  /** Stops caret ownership when dictation ends (manager calls this on stop). */
  override resetPreview(target: InsertionTarget): void {
    this.releasedPreview = null;
    this.disarmCaretGuardian();
    this.cancelPendingCaretReassert();
    this.awaitingUserCaret = null;
    this.userCaret = null;
    this.lastEnterGesture = null;
    super.resetPreview(target);
  }

  /**
   * True when the user has gestured in this editor since our last caret
   * write — they own the caret until we write at a position derived from
   * THEIR intent. Evaluated during a write (synchronous), so the gesture
   * counter relative to the last write is stable throughout it.
   */
  private userOwnsCaret(root: HTMLElement): boolean {
    return this.userCaretRoot === root && this.userGestureSequence > this.lastCaretWriteSequence;
  }

  protected override notifyChange(
    target: Extract<InsertionTarget, { type: 'contenteditable' }>,
    data?: string
  ): void {
    this.latestTarget = target;
    const root = target.element;
    // Read BEFORE lastCaretWriteSequence is updated below: this is "did the
    // user gesture since our previous write", not since this one.
    const userOwnsCaret = this.userOwnsCaret(root);
    const sequence = this.userGestureSequence;
    // Snapshot BEFORE notifyEditor: its input event makes Keep rebuild, and
    // a rebuild silently remaps the tracked range to (root,0) — snapshotted
    // after it, the restore would assert the caret at the START of the note.
    const caret = this.snapshotCaret(target);
    this.disarmCaretGuardian();
    this.cancelPendingCaretReassert();
    this.lastCaretWriteSequence = sequence;
    this.lastCaretWriteStamp = ++this.caretEventCounter;
    this.notifyEditor(root, data);
    // The restore re-asserts the caret at OUR write position, and it arms the
    // deferred re-assert chain plus the mutation guardian with it. When the
    // user is editing and this write could not be placed at their caret, that
    // re-assert is the observed yank (caret dragged to the last dictation
    // position → Enter broke the line at the wrong spot, Backspace lost its
    // place) — stand down and leave their caret alone.
    const placedAtUserCaret = this.writePlacedAtUserCaret;
    if (!userOwnsCaret || placedAtUserCaret) {
      if (this.userGestureSequence === sequence) this.restoreCaretAfterSync(target, caret);
    }
    // Our write just re-anchored everything; the recorded gesture caret is
    // now behind the inserted text and must not pull a later re-anchor back
    // to it. (Cleared last so a synchronous selectionchange from the restore
    // above cannot re-record our own caret as the user's.)
    //
    // A blind write never consumed the captured user caret — the words went
    // to the tracked anchor instead — so the record and the pending capture
    // window stay alive for the selectionchange carrying the user's real
    // caret. Clearing them here used to strand every later write of the
    // utterance on the previous line: the capture that arrived only after
    // Keep's rebuild had nowhere to land anymore.
    //
    // The pending capture is only retired when a user caret was actually
    // consumed, or when no fresh gesture is pending anymore (the window has
    // passed). A BLIND write — the post-Shift+Enter caret never captured,
    // text going to the tracked anchor — must keep the capture window OPEN:
    // the selectionchange carrying the user's real caret can arrive only
    // after Keep's rebuild, and closing the window on the first write used
    // to lock every later write of the utterance to the previous line.
    // Keeping it alive is echo-safe: a fresh gesture means every write since
    // it is blind, so nothing here restores the selection for a later
    // selectionchange to echo back (re-assert chain aborts on the gesture
    // gate, the guardian is disarmed).
    const consumedUserCaret = placedAtUserCaret;
    if (consumedUserCaret) {
      this.userCaret = null;
    }
    if (consumedUserCaret || !userOwnsCaret) this.awaitingUserCaret = null;
    this.writePlacedAtUserCaret = false;
  }

  /**
   * A write placed blind (the user is editing but their caret could not be
   * determined) must not drag the visible caret to the tracked position —
   * that is the Enter/Backspace caret-jump regression. When the placement
   * IS the user's caret (rebase, live adoption, continuation-at-caret), the
   * normal caret-following behavior applies.
   */
  protected override shouldMoveSelectionAfterWrite(target: InsertionTarget): boolean {
    if (target.type !== 'contenteditable') return super.shouldMoveSelectionAfterWrite(target);
    if (this.writePlacedAtUserCaret) return true;
    return !this.userOwnsCaret(target.element);
  }

  protected override noteUserCaretAdopted(): void {
    super.noteUserCaretAdopted();
    this.writePlacedAtUserCaret = true;
  }

  /**
   * Adopt a live caret in Keep's editors only when it represents genuine
   * user intent, and NEVER adopt a non-collapsed selection:
   *
   * 1. A non-collapsed selection on Keep is rejected outright. Keep's
   *    rebuilds remap the selection across whole lines while it re-renders
   *    (a manual Shift+Enter is a prime trigger), and an adopted
   *    non-collapsed range is DELETED outright by the next insertAtRange —
   *    observed as previously dictated text vanishing and "coming back" when
   *    Keep's model re-rendered it. Dictation never replaces a selection on
   *    Keep; the tracked anchors and the captured user caret own placement.
   * 2. Degenerate collapsed positions are never intent — EVEN right after a
   *    user gesture: when Keep replaces whole <p> elements mid-dictation,
   *    the browser collapses the orphaned selection to an element-edge
   *    position — very often (root,0) or (firstParagraph,0), i.e. the very
   *    START of the note. A deliberate post-Enter caret at (newParagraph, 0)
   *    is not a root-edge position and still passes.
   * 3. Even a well-formed text-level caret is trusted only when the user
   *    moved it AFTER our last caret write. Otherwise it is Keep/Chrome
   *    echoing our own edits back at us — typically one phrase behind, which
   *    is exactly how new speech kept landing on the previous line and
   *    getting concatenated with existing text. The tracked offset anchor
   *    (plus preview reclaim) already owns the caret in that case.
   */
  protected override shouldAdoptLiveCaret(root: HTMLElement, live: Range): boolean {
    if (!live.collapsed) return false;
    if (this.userCaretRoot === root && this.userGestureSequence > this.lastCaretWriteSequence) {
      if (this.isRebuildArtifactCaret(root, live)) return false;
      const record = this.userCaret;
      if (record && record.root === root && record.stamp > this.lastCaretWriteStamp) {
        // The gesture's own caret was captured — it owns placement through
        // the rebase. A live selection that is not exactly it is an echo of
        // our writes/rebuilds, never the user's intent: adopting it spliced
        // new speech at the start of the text (the observed "caret jumps to
        // the first character" vector).
        return record.container === live.startContainer && record.index === live.startOffset;
      }
      if (this.awaitingUserCaret === root) {
        // The gesture's caret never became readable (the capture just
        // failed) — whatever selection is live now is what Keep left
        // behind, not something the user moved to. Never adopt it blind;
        // the tracked anchors own placement for this write.
        return false;
      }
      return true;
    }
    return false;
  }

  /**
   * Keep's combobox note body is contenteditable="false" — focus lives on an
   * inner layer or is dropped entirely during rebuilds, so the base's exact
   * activeElement === root check never held there and every manual caret
   * move (Shift+Enter between phrases, clicking another line) was invisible
   * to insertion: text kept landing on the previous line. Trust the live
   * selection when focus is anywhere inside the editor, or when the user
   * gestured in this editor after our last write (their caret is then
   * authoritative even if focus bookkeeping is opaque). The adoption filter
   * (shouldAdoptLiveCaret) still vets the selection itself.
   */
  protected override shouldFollowLiveSelection(root: HTMLElement): boolean {
    const active = document.activeElement;
    if (active === root || (active !== null && root.contains(active))) return true;
    return this.userCaretRoot === root && this.userGestureSequence > this.lastCaretWriteSequence;
  }

  /**
   * When a stale/detached range must be re-anchored and the user's captured
   * post-gesture caret still resolves, prefer it over the numeric anchor:
   * after a manual line break the start of the new empty line and the end of
   * the previous line share the same textContent offset, and only the
   * block-anchored (container, offset) form can tell them apart. Preferred
   * offsets (preview spans) keep their semantics — the preview's words sit
   * where they sat, not where the user later moved.
   */
  protected override reanchorToContinue(root: HTMLElement, range: Range, preferredOffset?: number | null): void {
    if (preferredOffset == null) {
      const position = this.userCaretFor(root);
      if (position) {
        try {
          range.setStart(position.container, position.index);
          range.setEnd(position.container, position.index);
          this.anchorInsertionRange(root, range);
          return;
        } catch {
          /* stale snapshot — fall through to the offset anchors */
        }
      }
    }
    super.reanchorToContinue(root, range, preferredOffset);
  }

  /**
   * Never programmatically refocus a combobox that already holds (or
   * contains) focus: calling focus() on Keep's contenteditable=false editor
   * after one of its re-renders resets the caret to the START of the note.
   * Only refocus when focus genuinely left the editor; the selection asserted
   * after every mutation already keeps the caret visible otherwise.
   */
  protected override focusRootForInsert(root: HTMLElement): void {
    if (!isKeepComboboxEditor(root)) {
      super.focusRootForInsert(root);
      return;
    }
    if (document.activeElement !== root && !root.contains(document.activeElement)) {
      super.focusRootForInsert(root);
    }
  }

  /**
   * Snapshot where the caret should be, as a text offset. Taken AFTER the
   * mutation but BEFORE notifyEditor's input event makes Keep rebuild: text
   * offsets survive rebuilds (Keep preserves all text), while Range objects
   * do not — the browser silently remaps a tracked range whose container was
   * removed to (root,0), i.e. the very START of the note, and containment
   * checks cannot detect the remap (root contains itself).
   */
  private snapshotCaret(target: Extract<InsertionTarget, { type: 'contenteditable' }>): CaretSnapshot | null {
    const root = target.element;
    const range = target.range;
    if (!root.contains(range.startContainer) || !root.contains(range.endContainer)) return null;
    return this.snapshotPosition(root, range.startContainer, range.startOffset);
  }

  /** Snapshot an arbitrary (container, index) caret position inside root. */
  private snapshotPosition(root: HTMLElement, container: Node, index: number): CaretSnapshot | null {
    try {
      return {
        container,
        index,
        offset: this.textOffsetBefore(root, container, index),
        before: container.previousSibling,
        after: container.nextSibling,
        anchor: index === 0 && container.parentNode ? container.parentNode : null,
      };
    } catch {
      return null;
    }
  }

  /**
   * Capture the user's caret after a gesture, anchored to the block
   * structure so it survives Keep's rebuilds (see UserCaretRecord). Runs on
   * the selectionchange that follows the gesture (the browser moves the
   * caret as part of the gesture's default action — Enter's line break —
   * BEFORE Keep's rebuild can clear the selection) and lazily at write time
   * as a fallback. Only collapsed carets that pass the adoption filter are
   * recorded: the filter rejects the (root,0)/(first <p>,0) positions a
   * rebuild produces, so a rebuild artifact can never masquerade as the
   * user's post-Enter caret.
   *
   * `lazy` marks the write-time fallback read. Unlike the selectionchange
   * read it is not keyed to a browser caret move, so the selection it sees
   * may be a stale echo of our own writes (typically remapped to the start
   * of the text) rather than the gesture's outcome — such reads must also
   * pass the shape plausibility filter. The same filter guards captures
   * that surface only AFTER a write (`late`): the pending window is
   * deliberately kept open across blind writes so the user's real post-Enter
   * caret can still be recorded, but a position our own write's rebuild
   * produced must never be recorded as the user's intent — that is the
   * observed "caret jumps to the first character, then everything repeats
   * there" loop.
   */
  private captureUserCaret(root: HTMLElement, lazy = false): void {
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0) return;
    try {
      const live = selection.getRangeAt(0);
      if (!live.collapsed || !root.contains(live.commonAncestorContainer)) return;
      // Plausibility filter, NOT the write-time adoption policy: after our
      // own writes shouldAdoptLiveCaret deliberately treats every collapsed
      // caret as an echo, but this capture exists precisely to record the
      // USER's caret between writes. Only the rebuild-artifact positions
      // must still be rejected.
      if (this.isRebuildArtifactCaret(root, live)) return;
      const late = this.lastCaretWriteStamp > this.awaitingUserCaretStamp;
      if ((lazy || late) && !this.isPlausibleUserCaretShape(live)) return;
      const container = live.startContainer;
      const index = live.startOffset;
      let afterBreak = false;
      let breakOrdinal = 0;
      if (container.nodeType === Node.TEXT_NODE) {
        if (index === 0 && container.previousSibling instanceof HTMLBRElement) {
          afterBreak = true;
        }
      } else if (index > 0 && container.childNodes[index - 1] instanceof HTMLBRElement) {
        afterBreak = true;
      }
      if (!this.isPostEnterCaretPlausible(root, live, afterBreak)) return;
      if (afterBreak) {
        const br =
          container.nodeType === Node.TEXT_NODE
            ? (container.previousSibling as HTMLBRElement)
            : (container.childNodes[index - 1] as HTMLBRElement);
        breakOrdinal = this.softBreaksBefore(root, br);
      }
      let blockIndex = -1;
      let blockOffset = 0;
      const block = this.canonicalParagraph(root, container);
      if (block) {
        const blocks = root.querySelectorAll('p');
        blockIndex = Array.prototype.indexOf.call(blocks, block);
        blockOffset = this.textOffsetBefore(block, container, index);
      }
      this.userCaret = {
        root,
        container,
        index,
        blockIndex,
        blockOffset,
        afterBreak,
        breakOrdinal,
        offset: this.textOffsetBefore(root, container, index),
        stamp: ++this.caretEventCounter,
      };
      this.awaitingUserCaret = null;
    } catch {
      /* unreadable selection — keep waiting for a readable one */
    }
  }

  /**
   * How many <br> elements of the block containing `br` come before it.
   * Recorded with the caret so the after-break resolution below can pick the
   * right one of two consecutive soft breaks, which share a text offset.
   */
  private softBreaksBefore(root: HTMLElement, br: HTMLBRElement): number {
    const block = this.canonicalParagraph(root, br) ?? br.parentElement;
    if (!block) return 0;
    let ordinal = 0;
    const walker = document.createTreeWalker(block, NodeFilter.SHOW_ELEMENT);
    let node = walker.nextNode();
    while (node) {
      if (node instanceof HTMLBRElement && node !== br) {
        try {
          if (node.compareDocumentPosition(br) & Node.DOCUMENT_POSITION_FOLLOWING) ordinal += 1;
        } catch {
          /* detached — skip */
        }
      }
      node = walker.nextNode();
    }
    return ordinal;
  }

  /**
   * Whether a collapsed caret can plausibly be a gesture OUTCOME when it is
   * read lazily at write time or arrives only after one of our writes.
   * Mid-text carets are fine. A text start counts only right after a <br>
   * (the line start a soft break creates); an element position counts only
   * right after a <br> or on an empty line/block (a hard-break target).
   * Everything else is the degenerate start-of-content remap our own
   * writes' rebuilds produce — never the user's intent.
   */
  private blockIndexForPosition(root: HTMLElement, container: Node): number {
    const block =
      this.canonicalParagraph(root, container) ??
      (container instanceof Element
        ? container.closest('p,div,li')
        : container.parentElement?.closest('p,div,li'));
    if (!(block instanceof HTMLElement) || !root.contains(block)) return -1;
    const blocks = Array.from(root.querySelectorAll('p,div,li'));
    return blocks.indexOf(block);
  }

  private isPostEnterCaretPlausible(root: HTMLElement, live: Range, afterBreak: boolean): boolean {
    const gesture = this.lastEnterGesture;
    if (!gesture || gesture.root !== root || gesture.fromBlockIndex < 0) return true;
    if (afterBreak) return true;
    const blockIndex = this.blockIndexForPosition(root, live.startContainer);
    if (blockIndex > gesture.fromBlockIndex) return true;
    if (blockIndex === gesture.fromBlockIndex) return false;
    if (live.startContainer === root) {
      const before = root.childNodes[live.startOffset - 1] ?? null;
      const after = root.childNodes[live.startOffset] ?? null;
      const isLineBlock = (node: Node | null): boolean =>
        node instanceof HTMLElement && /^(P|DIV|LI)$/.test(node.tagName);
      if (isLineBlock(before) || isLineBlock(after)) return true;
    }
    if (gesture.fromOffset !== null) {
      try {
        return this.textOffsetBefore(root, live.startContainer, live.startOffset) >= gesture.fromOffset;
      } catch {
        return true;
      }
    }
    return true;
  }

  private isPlausibleUserCaretShape(live: Range): boolean {
    const container = live.startContainer;
    const index = live.startOffset;
    if (container.nodeType === Node.TEXT_NODE) {
      if (index > 0) return true;
      return container.previousSibling instanceof HTMLBRElement;
    }
    if (container instanceof Element) {
      if (index > 0) return container.childNodes[index - 1] instanceof HTMLBRElement;
      return (container.textContent ?? '').length === 0;
    }
    return false;
  }

  /**
   * The captured user caret, resolved back to a live (container, index).
   * Resolution order: the exact nodes while their identity and offset still
   * hold; then the block anchor (the k-th canonical <p> — the same LINE
   * after a rebuild, even though the nodes are new); then the global text
   * offset. The block step is what keeps the post-Enter caret on the new
   * line when Keep replaces the paragraph before the next write lands.
   *
   * A captured position that sat right after a soft break must NEVER fall
   * back to the plain text-offset mapping: the start of the new line and the
   * end of the previous line share one textContent offset, and the numeric
   * mapping would put the continuation on the OLD side of the <br> — the
   * observed "words keep landing on the line I just left". The after-break
   * resolution locates the break itself instead.
   */
  private userCaretFor(root: HTMLElement): CaretPosition | null {
    const record = this.userCaret;
    if (!record || record.root !== root || !root.isConnected) return null;
    if (root.contains(record.container)) {
      try {
        if (this.textOffsetBefore(root, record.container, record.index) === record.offset) {
          return { container: record.container, index: record.index };
        }
      } catch {
        /* fall through to the block anchor */
      }
    }
    if (record.blockIndex >= 0) {
      const blocks = root.querySelectorAll('p');
      const block = blocks[record.blockIndex] as HTMLElement | undefined;
      if (block) {
        try {
          if (record.afterBreak) {
            const after = this.locateAfterSoftBreak(block, record.blockOffset, record.breakOrdinal);
            if (after) return after;
          }
          const at = this.locateTextOffset(block, record.blockOffset, true);
          if (at) return { container: at.startContainer, index: at.startOffset };
          if ((block.textContent ?? '').length === 0) return { container: block, index: 0 };
        } catch {
          /* fall through to the global offset */
        }
      }
    }
    const global = this.locateTextOffset(root, record.offset, true);
    return global ? { container: global.startContainer, index: global.startOffset } : null;
  }

  /**
   * The position just after the <br> in `block` whose left side holds
   * exactly `offset` characters of block text — the caret a soft
   * Shift+Enter leaves behind, expressed structurally so it survives Keep's
   * rebuilds (which replace the nodes but preserve the text and the breaks).
   * `ordinal` disambiguates consecutive breaks, which share one text offset:
   * the k-th break the user moved behind wins. Returns null when no break
   * matches (the structure changed) and the caller falls back.
   */
  private locateAfterSoftBreak(block: HTMLElement, offset: number, ordinal: number): CaretPosition | null {
    const matches: CaretPosition[] = [];
    const walker = document.createTreeWalker(block, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT);
    let total = 0;
    let node = walker.nextNode();
    while (node) {
      if (node instanceof HTMLBRElement) {
        if (total === offset && node.parentNode) {
          matches.push({
            container: node.parentNode,
            index: Array.prototype.indexOf.call(node.parentNode.childNodes, node) + 1,
          });
        }
      } else if (node.nodeType === Node.TEXT_NODE) {
        total += node.textContent?.length ?? 0;
      }
      node = walker.nextNode();
    }
    if (matches.length === 0) return null;
    return matches[Math.min(ordinal, matches.length - 1)]!;
  }

  /** True when a manual Enter broke the line in `root` after our last write. */
  private enterGestureFresh(root: HTMLElement): boolean {
    const gesture = this.lastEnterGesture;
    return gesture !== null && gesture.root === root && gesture.sequence > this.lastCaretWriteSequence;
  }

  /**
   * The position just after the manual line break(s) that follow `fromOffset`,
   * or null when no break sits there — `breaks` of them, crossed in order.
   * This is the DOM-inferred fallback for the user's post-Enter caret when
   * the selectionchange capture missed it (Keep's rebuild often clears the
   * selection before it can be read): the caret was at the end of the
   * delivered text when the user pressed Enter, so the break the gesture
   * created sits right after it — a <br> for Shift+Enter's soft break, a
   * new block for Enter's hard break. Both sides of the break share one
   * textContent offset, which is exactly why the numeric anchors cannot
   * express this position. Deliberately conservative: anything that does
   * not match the two break shapes returns null and the write falls back
   * to the tracked anchors.
   */
  private positionAfterManualBreak(root: HTMLElement, fromOffset: number, breaks = 1): CaretPosition | null {
    const at = this.locateTextOffset(root, fromOffset);
    if (!at) return null;
    let position: CaretPosition = { container: at.startContainer, index: at.startOffset };
    for (let crossed = 0; crossed < breaks; crossed += 1) {
      const next = this.crossManualBreak(root, position);
      if (!next) return null;
      position = next;
    }
    return position;
  }

  private crossManualBreak(root: HTMLElement, position: CaretPosition): CaretPosition | null {
    const node = position.container;
    const index = position.index;
    // A <br> immediately after the position (same parent) is the soft
    // (Shift+Enter) break; the caret lives right after it.
    if (node.nodeType === Node.TEXT_NODE) {
      if (index < (node.textContent?.length ?? 0)) return null; // mid-text: no break here
      const after = node.nextSibling;
      if (after instanceof HTMLBRElement && after.parentNode) {
        return {
          container: after.parentNode,
          index: Array.prototype.indexOf.call(after.parentNode.childNodes, after) + 1,
        };
      }
    } else if (node instanceof Element) {
      const after = node.childNodes[index] ?? null;
      if (after instanceof HTMLBRElement) return { container: node, index: index + 1 };
      if (after !== null) return null; // content continues right here — no break
    }
    // No soft break at the position: a hard (Enter) break shows up as the
    // end of the current block with the gesture's new block after it (or a
    // trailing <br> inside the block). Only the very end of a block counts —
    // a mid-block position has no break to cross.
    const containerElement = node.nodeType === Node.TEXT_NODE ? node.parentElement : node;
    if (!(containerElement instanceof Element)) return null;
    const block =
      this.canonicalParagraph(root, node) ??
      (containerElement.closest('p,div,li') as HTMLElement | null);
    if (!(block instanceof HTMLElement) || !root.contains(block)) return null;
    try {
      if (this.textOffsetBefore(block, node, index) !== (block.textContent ?? '').length) return null;
    } catch {
      return null;
    }
    const last = block.lastChild;
    if (last instanceof HTMLBRElement && last !== node) {
      return { container: block, index: block.childNodes.length };
    }
    // A hard break creates a new LINE block after the current one. Siblings
    // of a different shape (Keep's inner document layer, UI wrappers) are
    // not lines the gesture created — skip them; when the root uses the
    // canonical <p> structure, only a <p> counts.
    const usesParagraphs = root.querySelectorAll('p').length > 0;
    let nextBlock = block.nextElementSibling;
    while (nextBlock instanceof HTMLElement && root.contains(nextBlock)) {
      if (usesParagraphs ? nextBlock.tagName === 'P' : nextBlock.tagName === block.tagName) {
        return { container: nextBlock, index: 0 };
      }
      nextBlock = nextBlock.nextElementSibling;
    }
    return null;
  }

  /**
   * The position just after the manual break(s) the user created, resolved
   * from whichever candidate starting offset actually has a break behind it.
   *
   * Two anchors describe where that break can be, and neither is always the
   * right one on its own:
   *
   * - `fromOffset` — where the caret stood when Enter was pressed. The break
   *   sits right after the text that existed then.
   * - the tracked range's current offset — which has advanced past `fromOffset`
   *   whenever a blind write extended the line the user left, in which case
   *   the break is behind *that* offset instead.
   *
   * Anchoring on only one of them puts the next words on the previous line
   * whenever the other is the real one, and a write that lands there also
   * drags the visible caret back across the break (so the user's next Enter
   * splits the previous line). Returns null only when no candidate has a
   * break behind it, leaving the caller on its tracked anchors.
   */
  private inferPositionAfterManualBreaks(
    root: HTMLElement,
    offsets: Array<number | null | undefined>,
    breaks: number
  ): CaretPosition | null {
    const tried = new Set<number>();
    for (const offset of offsets) {
      if (offset === null || offset === undefined || !Number.isFinite(offset) || offset < 0) continue;
      if (tried.has(offset)) continue;
      tried.add(offset);
      try {
        const position = this.positionAfterManualBreak(root, offset, breaks);
        if (position) return position;
      } catch {
        /* unreadable offset — try the next candidate */
      }
    }
    return null;
  }

  /**
   * First write after a user gesture: start from the caret the gesture
   * produced instead of the pre-gesture tracked range. The generic
   * live-caret adoption below cannot be relied on for this — Keep clears
   * the selection while rebuilding — but the block-anchored record
   * survives that. Marks the write as placed at the user's caret so the
   * visible-caret gates allow their normal caret-following behavior.
   */
  private rebaseToUserCaretIfTrusted(target: Extract<InsertionTarget, { type: 'contenteditable' }>): void {
    const root = target.element;
    if (this.userCaretRoot !== root) return;
    // The record is trusted when the gesture that produced it is still
    // fresher than our last write, OR when the capture itself happened
    // after that write: the selectionchange carrying the user's post-Enter
    // caret routinely arrives only after Keep's rebuild made the first
    // write go blind — the placement must still follow the user's line
    // from the next result on. The capture filter (isRebuildArtifactCaret)
    // plus the no-echo invariant (a pending capture implies blind writes,
    // which never restore the selection) make that record trustworthy.
    const gestureFresh = this.userGestureSequence > this.lastCaretWriteSequence;
    const capturedFresh = this.userCaret !== null && this.userCaret.stamp > this.lastCaretWriteStamp;
    if (!gestureFresh && !capturedFresh) return;
    let position = this.userCaretFor(root);
    if (!position && this.enterGestureFresh(root)) {
      // The selectionchange capture missed the post-Enter caret (Keep's
      // rebuild clears the selection), but the gesture always broke the line
      // where the caret stood — infer the continuation point from the DOM
      // instead of gluing the next words to the previous line.
      //
      // At least one break is always crossed: a fresh Enter moved the caret
      // past one, and returning the pre-break position here would be marked
      // as the user's caret — the words would land on the previous line and
      // the visible caret would follow them there, so the user's next Enter
      // split the previous line at the dictation offset.
      try {
        const tracked = this.textOffsetBefore(root, target.range.startContainer, target.range.startOffset);
        position = this.inferPositionAfterManualBreaks(
          root,
          [this.lastEnterGesture?.fromOffset, tracked],
          Math.max(1, this.releasedPreview?.manualBreaks ?? 1)
        );
      } catch {
        position = null;
      }
    }
    if (!position) return;
    try {
      target.range.setStart(position.container, position.index);
      target.range.setEnd(position.container, position.index);
      this.anchorInsertionRange(root, target.range);
      this.writePlacedAtUserCaret = true;
    } catch {
      /* stale snapshot — the numeric anchors stay in charge */
    }
  }

  /**
   * Re-assert the visible caret after Keep's input sync. notifyEditor makes
   * Keep rebuild its canonical <p> tree, which detaches the selection our
   * mutation just set — leaving the caret wherever Keep's renderer dropped
   * it (often the start) while our tracked range still points at the right
   * place. Relocate the tracked range AND the browser selection to the
   * snapshotted text offset, so the caret the user sees and the position the
   * next phrase targets never diverge. Falls back to the anchored end of
   * content when the offset cannot be mapped (e.g. Keep dropped text).
   *
   * A guarded macrotask re-assert follows: if Keep reconciles the selection
   * asynchronously from a stale model (debounced, a microtask/rAF after our
   * synchronous dispatch), it can drag the visible caret back a line AFTER
   * we fixed it. The deferred pass re-asserts the same offset — but ONLY if
   * nothing newer happened meanwhile (newer mutation cancels it via the
   * single slot, a newer user gesture aborts it, focus having left the
   * editor aborts it). Because Keep's reconciliation times are unbounded
   * (rAF-aligned passes plus a debounced model sync measured past 300ms),
   * the fixed passes alone still left windows where a remap parked the
   * caret at the start; an event-driven guardian (armCaretGuardian) closes
   * that gap by repairing any remap as it happens. It never touches other
   * sites: this whole path is Keep-adapter-only.
   */
  private restoreCaretAfterSync(
    target: Extract<InsertionTarget, { type: 'contenteditable' }>,
    caret: CaretSnapshot | null
  ): void {
    const root = target.element;
    const range = target.range;
    const valid = caret !== null && this.caretSnapshotValid(root, caret);
    let assertedOffset: number | null = null;
    if (valid && caret) {
      try {
        range.setStart(caret.container, caret.index);
        range.setEnd(caret.container, caret.index);
        assertedOffset = caret.offset;
      } catch {
        range.selectNodeContents(root);
        range.collapse(false);
        this.anchorInsertionRange(root, range);
      }
    } else if (caret) {
      const located = this.locateTextOffset(root, caret.offset);
      if (located) {
        try {
          range.setStart(located.startContainer, located.startOffset);
          range.setEnd(located.startContainer, located.startOffset);
          assertedOffset = caret.offset;
        } catch {
          range.selectNodeContents(root);
          range.collapse(false);
          this.anchorInsertionRange(root, range);
        }
      } else {
        range.selectNodeContents(root);
        range.collapse(false);
        this.anchorInsertionRange(root, range);
      }
    } else {
      range.selectNodeContents(root);
      range.collapse(false);
      this.anchorInsertionRange(root, range);
    }
    if (assertedOffset === null) {
      try {
        assertedOffset = this.textOffsetBefore(root, range.startContainer, range.startOffset);
      } catch {
        assertedOffset = null;
      }
    }
    try {
      const selection = window.getSelection();
      if (selection) {
        selection.removeAllRanges();
        selection.addRange(range.cloneRange());
      }
    } catch {
      /* selection update is best-effort */
    }
    const carried = valid && caret ? caret : assertedOffset;
    if (carried !== null) {
      this.scheduleCaretReassert(target, carried);
      this.armCaretGuardian(target, carried);
    }
  }
  /**
   * Arm (or re-arm) the event-driven caret guardian after a caret write:
   * any Keep reconciliation that remaps or clears the selection inside
   * `element` is repaired back to `offset` until the guard window expires,
   * the user takes over, or the editor goes away. A newer write re-arms with
   * its own offset (single slot).
   */
  private armCaretGuardian(
    target: Extract<InsertionTarget, { type: 'contenteditable' }>,
    caret: CaretSnapshot | number
  ): void {
    this.guard = {
      element: target.element,
      offset: typeof caret === 'number' ? caret : caret.offset,
      snapshot: typeof caret === 'number' ? null : caret,
      target,
    };
    this.guardObserver?.disconnect();
    this.guardObserver?.observe(target.element, { childList: true, subtree: true, characterData: true });
  }

  private caretSnapshotValid(root: HTMLElement, snapshot: CaretSnapshot): boolean {
    if (!root.contains(snapshot.container)) return false;
    try {
      if (snapshot.index > (snapshot.container.textContent?.length ?? 0)) return false;
      if (snapshot.container.previousSibling !== snapshot.before) return false;
      if (snapshot.container.nextSibling !== snapshot.after) return false;
      if (
        snapshot.anchor !== null &&
        (snapshot.container.parentNode !== snapshot.anchor || snapshot.index !== 0)
      ) {
        return false;
      }
      return this.textOffsetBefore(root, snapshot.container, snapshot.index) === snapshot.offset;
    } catch {
      return false;
    }
  }

  private disarmCaretGuardian(): void {
    this.guard = null;
    this.guardObserver?.disconnect();
  }

  /**
   * Repair the guarded caret. Called from the guarded editor's
   * MutationObserver and from selectionchange, closing the gap the fixed
   * re-assert chain cannot: Keep's debounced reconciliation can remap the
   * caret to the start of the note long after the chain's last pass, and
   * every such remap used to park the caret at the start until the next
   * phrase (the observed "jumps to the start, then back" during dictation).
   *
   * Guards, in order: not armed → no-op; guard window expired → disarm; a
   * user gesture happened after our last write → disarm (their caret is
   * theirs); editor removed → disarm; focus elsewhere → stand down WITHOUT
   * disarming (Keep moves focus during re-renders and may hand it back); a
   * non-collapsed selection inside the editor → never touch a real text
   * selection; selection already at the asserted text offset → no-op (this
   * also terminates the selectionchange loop our own repairs cause).
   *
   * Returns true when a repair was applied.
   */
  private repairGuardedCaret(): boolean {
    const guard = this.guard;
    if (!guard) return false;
    // A user-caret capture is pending (a gesture just happened and the
    // caret has not been read yet) — the selection about to arrive is the
    // USER's, never a remap to repair. Touching it would yank the caret
    // back to the last dictation position.
    if (this.awaitingUserCaret) return false;
    if (this.userGestureSequence > this.lastCaretWriteSequence) {
      this.disarmCaretGuardian();
      return false;
    }
    const element = guard.element;
    if (!element.isConnected) {
      this.disarmCaretGuardian();
      return false;
    }
    if (document.activeElement !== element && !element.contains(document.activeElement)) {
      return false;
    }
    const selection = window.getSelection();
    if (!selection) return false;
    if (selection.rangeCount > 0) {
      let live: Range;
      try {
        live = selection.getRangeAt(0);
      } catch {
        return false;
      }
      if (!live.collapsed) return false;
      if (!element.contains(live.commonAncestorContainer)) return false;
      try {
        if (this.textOffsetBefore(element, live.startContainer, live.startOffset) === guard.offset) {
          return false; // already where it belongs
        }
      } catch {
        /* unreadable live position — fall through to the repair */
      }
    }
    const snapshot = guard.snapshot && this.caretSnapshotValid(element, guard.snapshot) ? guard.snapshot : null;
    const located = snapshot
      ? { startContainer: snapshot.container, startOffset: snapshot.index }
      : this.locateTextOffset(element, guard.offset);
    if (!located) return false; // Keep dropped the text — the next write re-arms
    try {
      const caret = document.createRange();
      caret.setStart(located.startContainer, located.startOffset);
      caret.collapse(true);
      selection.removeAllRanges();
      selection.addRange(caret);
      guard.target.range.setStart(located.startContainer, located.startOffset);
      guard.target.range.setEnd(located.startContainer, located.startOffset);
      return true;
    } catch {
      return false;
    }
  }

  /** Guarded deferred re-assert of a previously asserted caret offset. */
  private scheduleCaretReassert(
    target: Extract<InsertionTarget, { type: 'contenteditable' }>,
    caret: CaretSnapshot | number
  ): void {
    this.pendingCaretReassertCancel?.();
    this.writeSequenceAtSchedule = this.userGestureSequence;
    const element = target.element;
    const snapshot = typeof caret === 'number' ? null : caret;
    const offset = typeof caret === 'number' ? caret : caret.offset;
    let cancelled = false;
    const cancel = (): void => {
      cancelled = true;
      this.pendingCaretReassertCancel = null;
    };
    this.pendingCaretReassertCancel = cancel;

    const assert = (): void => {
      if (cancelled) return;
      try {
        if (!element.isConnected) return;
        if (this.userGestureSequence > this.writeSequenceAtSchedule) return;
        if (document.activeElement !== element && !element.contains(document.activeElement)) return;
        const located =
          snapshot && this.caretSnapshotValid(element, snapshot)
            ? { startContainer: snapshot.container, startOffset: snapshot.index }
            : this.locateTextOffset(element, offset);
        if (!located) return;
        const selection = window.getSelection();
        if (!selection) return;
        const caret = document.createRange();
        caret.setStart(located.startContainer, located.startOffset);
        caret.collapse(true);
        selection.removeAllRanges();
        selection.addRange(caret);
      } catch {
        /* best effort */
      }
    };

    const nextFrame = (cb: () => void): void => {
      // jsdom and some embedded contexts lack rAF — a short timeout matches
      // its intent closely enough for this guarded pass.
      if (typeof requestAnimationFrame === 'function') {
        requestAnimationFrame(() => cb());
      } else {
        setTimeout(cb, 16);
      }
    };

    // Keep's renderer can drag the caret back after our synchronous restore
    // at different times: immediately (microtask), on the next animation
    // frames (rAF-aligned reconciliation — which fire AFTER a setTimeout(0)
    // macrotask, so the old single pass always lost that race), or from a
    // debounced model sync. Re-assert the same offset on a short guarded
    // schedule covering all three; every pass re-checks the guards above.
    const schedulePass = (pass: number): void => {
      if (cancelled) return;
      if (pass === 0) {
        setTimeout(() => {
          if (cancelled) return;
          assert();
          schedulePass(1);
        }, 0);
      } else if (pass <= 2) {
        nextFrame(() => {
          if (cancelled) return;
          assert();
          schedulePass(pass + 1);
        });
      } else {
        setTimeout(() => {
          if (cancelled) return;
          assert();
          cancel();
        }, 250);
      }
    };
    schedulePass(0);
  }

  /**
   * Keep's Docs-style editors (note body + every checklist item) render text
   * ONLY inside their canonical <p> children — the renderer rebuilds those
   * children on every input-event sync and drops anything else. A text node
   * appended directly to the combobox root (the generic end-of-content
   * fallback position) flashes and is deleted on the next sync, which looked
   * like "only the first spoken word is inserted". Re-anchor any insertion
   * that would land outside a canonical <p> to the end of the last one.
   */
  protected override anchorInsertionRange(root: HTMLElement, range: Range): void {
    // Backstop for the capture-time clamp: dictation never replaces a
    // selection on Keep (spec §43). insertAtRange deleteContents() whatever
    // the range spans, so a non-collapsed range reaching it would wipe the
    // text between its ends — observed as previously written text vanishing
    // and "coming back" once Keep re-renders it from its model. Collapse to
    // the start so dictation continues there. This runs before every plain
    // insertion and preview, catching any range that became non-collapsed
    // after capture (a rebuild remap, an unclosed adoption).
    if (!range.collapsed) {
      try {
        range.setEnd(range.startContainer, range.startOffset);
      } catch {
        range.collapse(true);
      }
    }
    if (!isKeepComboboxEditor(root)) return;
    const start = range.startContainer;
    const end = range.endContainer;
    if (
      root.contains(start) &&
      root.contains(end) &&
      this.canonicalParagraph(root, start) !== null &&
      this.canonicalParagraph(root, end) !== null
    ) {
      return; // already inside the canonical paragraph structure
    }
    const last = this.lastCanonicalParagraph(root);
    if (!last) return; // nothing to anchor into — keep the current position
    const offset = last.childNodes.length;
    range.setStart(last, offset);
    range.setEnd(last, offset);
  }

  /** Nearest ancestor-or-self <p> of `node` that lives inside this editor. */
  private canonicalParagraph(root: HTMLElement, node: Node): HTMLParagraphElement | null {
    let current: Node | null = node.nodeType === Node.TEXT_NODE ? node.parentNode : node;
    while (current) {
      if (current === root) return null;
      if (current instanceof HTMLParagraphElement && root.contains(current)) return current;
      current = current.parentNode;
    }
    return null;
  }

  /** The editor's last canonical paragraph, in document order. */
  private lastCanonicalParagraph(root: HTMLElement): HTMLParagraphElement | null {
    const paragraphs = root.querySelectorAll('p');
    return (paragraphs[paragraphs.length - 1] as HTMLParagraphElement | undefined) ?? null;
  }

  /** Make Keep's editor register the change (save/sync triggers on input). */
  private notifyEditor(root: HTMLElement, data?: string): void {
    try {
      // Dispatch BOTH beforeinput and input. Keep's Docs-style editors
      // (combobox note body / checklist items) sync on the input-event
      // pipeline; some of their sync listeners only run on beforeinput.
      // A single synchronous `input` can lose the race against Keep's
      // debounced model update: when the user stops dictation (popup Stop
      // changes focus → combobox blur → Keep saves from its model), a save
      // that runs before Keep's handler processes our event would capture a
      // stale model and the just-dictated words would vanish. Dispatching
      // beforeinput first maximizes the chance the sync listener observes
      // the new DOM synchronously, before any subsequent blur-save.
      root.dispatchEvent(new InputEvent('beforeinput', { bubbles: true, cancelable: true, inputType: 'insertText', data }));
      root.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data }));
    } catch {
      // Event construction unavailable — the change still renders.
    }
  }
}
