import type { Language, RecognitionStatus } from '../shared/types';
import { isActiveState } from '../shared/state';
import { languageLabel } from '../shared/languages';
import { loadBadgePosition, saveBadgePosition } from '../shared/storage';

const BADGE_HTML = `
<style>
  :host { all: initial; }
  .wrap { display: flex; flex-direction: column; align-items: center; gap: 4px; }
  .badge {
    position: relative;
    width: 34px; height: 34px; border-radius: 50%;
    display: flex; align-items: center; justify-content: center;
    background: #111827; border: 2px solid #374151;
    font-size: 17px; line-height: 1;
    box-shadow: 0 2px 10px rgba(0,0,0,.35);
    user-select: none; cursor: grab; touch-action: none;
    transition: border-color .25s, box-shadow .25s, opacity .25s;
  }
  .badge.dragging { cursor: grabbing; }
  .badge .icon { filter: grayscale(1); opacity: .55; transition: filter .25s, opacity .25s; }
  .badge[data-state="idle"] { opacity: .8; }
  .badge[data-state="active"] {
    border-color: #22c55e;
    box-shadow: 0 0 0 3px rgba(34,197,94,.25), 0 2px 10px rgba(0,0,0,.35);
  }
  .badge[data-state="active"] .icon { filter: none; opacity: 1; }
  .badge[data-state="error"] {
    border-color: #ef4444;
    box-shadow: 0 0 0 3px rgba(239,68,68,.25), 0 2px 10px rgba(0,0,0,.35);
  }
  .badge[data-state="error"] .icon { filter: none; opacity: 1; }
  .pulse {
    position: absolute; inset: -4px; border-radius: 50%;
    border: 2px solid rgba(34,197,94,.6); opacity: 0; pointer-events: none;
  }
  .badge[data-state="active"] .pulse { animation: vt-pulse 1.6s ease-out infinite; }
  @keyframes vt-pulse {
    0% { transform: scale(.9); opacity: .8; }
    100% { transform: scale(1.35); opacity: 0; }
  }
  @media (prefers-reduced-motion: reduce) {
    .badge .pulse { animation: none; opacity: 0; }
  }
  /* Transient bubble under the badge: the language name, or a one-off note
     such as "copied to clipboard". Capped and wrappable so the longer messages
     do not stretch the badge's own hit area across the page. */
  .note {
    font: 11px/1.4 system-ui, 'Segoe UI', Vazirmatn, Tahoma, sans-serif;
    color: #e5e7eb;
    background: rgba(17,24,39,.92);
    border: 1px solid #374151;
    border-radius: 12px;
    padding: 3px 8px;
    max-width: 200px;
    text-align: center;
    text-wrap: balance;
    pointer-events: none;
    opacity: 0;
    transition: opacity .3s;
  }
  .note.visible { opacity: 1; }
</style>
<div class="wrap">
  <div class="badge" data-state="idle" role="button" title="Easy speech — Ready (click: start/stop · drag: move)" aria-label="Easy speech — Ready">
    <span class="pulse"></span>
    <span class="icon">🎙️</span>
  </div>
  <span class="note"></span>
</div>
`;

const STATE_LABELS: Record<RecognitionStatus['state'], string> = {
  idle: 'Ready',
  starting: 'Starting…',
  listening: 'Listening…',
  processing: 'Processing…',
  restarting: 'Restarting…',
  error: 'Error',
  stopping: 'Stopping…',
};

const TITLE_HINT = ' · click = start/stop, drag = move';

/** How long the language label stays visible after a change (ms). */
const LANGUAGE_LABEL_VISIBLE_MS = 2500;

/** Pointer movement beyond this many pixels turns a press into a drag. */
const DRAG_THRESHOLD_PX = 4;

export interface StatusIndicatorOptions {
  /** Invoked on a plain click (no drag): the host page starts/stops dictation. */
  onToggle?: (capturedFocus: Element | null) => void;
}

/**
 * Floating mic badge on the page edge (spec §17).
 *
 * - Hidden until dictation becomes active in the tab (e.g. after the
 *   toggle-dictation shortcut or a popup start) — then it appears and stays
 *   so it can be reused.
 * - Plain click toggles dictation (via the host-provided `onToggle`).
 * - Draggable anywhere on screen; the position is remembered per browser.
 * Lives in a shadow root so page CSS cannot restyle it; dynamic values are
 * written through attributes only — never HTML (spec §39).
 */
export class StatusIndicator {
  private host: HTMLDivElement | null = null;
  private badge: HTMLElement | null = null;
  /** Feature gate from prefs (options page → General). */
  private enabled = true;
  /** True once dictation has run in this tab — the badge stays available. */
  private summoned = false;
  private visible = false;
  private lastStatus: RecognitionStatus | null = null;
  private noteBubble: HTMLElement | null = null;
  private noteTimer: ReturnType<typeof setTimeout> | null = null;
  private shownLanguage: string | null = null;
  private shownNote: string | null = null;
  private readonly onToggle: (capturedFocus: Element | null) => void;

  private dragging = false;
  private dragMoved = false;
  private activePointerId: number | undefined = undefined;
  private startClient = { x: 0, y: 0 };
  private startHost = { x: 0, y: 0 };
  /** Last position applied to the host (source of truth for persistence). */
  private appliedPosition = { x: 0, y: 0 };
  /** Focus at the instant of pointerdown — captured BEFORE mousedown blur. */
  private pointerDownFocus: Element | null = null;

  constructor(options: StatusIndicatorOptions = {}) {
    this.onToggle = options.onToggle ?? (() => {});
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', () => this.ensureHost(), { once: true });
    } else {
      this.ensureHost();
    }
  }

  /** Feature gate from prefs. Disabling always hides the badge; enabling shows
   * it again only if it was summoned before (or is currently dictating).
   */
  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    if (!enabled) {
      this.hide();
      return;
    }
    if (this.summoned) this.show();
  }

  update(status: RecognitionStatus): void {
    this.lastStatus = status;
    if (!this.enabled) return;

    // Summon on the first active status (dictation started via shortcut,
    // popup, or badge click).
    if (!this.summoned && isActiveState(status.state)) {
      this.summoned = true;
      this.show();
    }
    if (!this.visible) return;
    this.ensureHost();
    this.apply(status);
    this.maybeShowLanguage(status.language);
    this.maybeShowNote(status.note);
  }

  // ---- visibility ----------------------------------------------------------

  private show(): void {
    this.visible = true;
    this.ensureHost();
    if (!this.host) return;
    this.host.style.display = 'block';
    void this.restorePosition();
  }

  private hide(): void {
    this.visible = false;
    this.clearNote();
    if (this.host) this.host.style.display = 'none';
  }

  /** Applies the remembered position (clamped to the current viewport). */
  private async restorePosition(): Promise<void> {
    const saved = await loadBadgePosition();
    if (!saved || !this.visible || !this.host) return;
    this.applyPosition(this.clampPosition(saved));
  }

  // ---- rendering -----------------------------------------------------------

  private apply(status: RecognitionStatus): void {
    if (!this.badge) return;
    const state = status.state === 'error' ? 'error' : isActiveState(status.state) ? 'active' : 'idle';
    this.badge.setAttribute('data-state', state);

    const title = status.lastError
      ? `Easy speech — Error: ${status.lastError.message}`
      : `Easy speech — ${STATE_LABELS[status.state]}`;
    this.badge.setAttribute('title', `${title}${TITLE_HINT}`);
    this.badge.setAttribute('aria-label', `${title}${TITLE_HINT}`);
  }

  // ---- transient bubble -------------------------------------------------------

  /** Shows the language name under the badge whenever it changes. */
  private maybeShowLanguage(language: string | null): void {
    if (!language || language === this.shownLanguage) return;
    this.shownLanguage = language;
    this.showNote(languageLabel(language as Language));
  }

  /**
   * Shows a one-off message ("copied to clipboard") under the badge. Only on a
   * change: `note` stays in the status for as long as the session is settled,
   * and re-showing it on every status broadcast would leave the bubble pinned
   * open instead of fading.
   */
  private maybeShowNote(note: string | null): void {
    if (!note || note === this.shownNote) return;
    this.shownNote = note;
    this.showNote(note);
  }

  private showNote(text: string): void {
    if (!this.noteBubble) return;
    this.noteBubble.textContent = text;
    this.noteBubble.classList.add('visible');
    if (this.noteTimer !== null) clearTimeout(this.noteTimer);
    this.noteTimer = setTimeout(() => {
      this.noteTimer = null;
      this.noteBubble?.classList.remove('visible');
    }, LANGUAGE_LABEL_VISIBLE_MS);
  }

  private clearNote(): void {
    if (this.noteTimer !== null) {
      clearTimeout(this.noteTimer);
      this.noteTimer = null;
    }
    this.noteBubble?.classList.remove('visible');
  }

  // ---- drag + click ----------------------------------------------------------

  private onPointerDown(event: PointerEvent): void {
    if (!this.visible || !this.host) return;
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    // Capture the field focus BEFORE the interaction can blur it — mousedown
    // on a non-focusable overlay blurs the active input in Chrome (activeElement
    // becomes body) before pointerup fires. Storing here guarantees the correct
    // insertion target for the floating button, critical for correct cursor
    // position and for preventing word duplication when the preview is anchored
    // at the wrong offset (observed with English dictation via the badge).
    this.pointerDownFocus = document.activeElement instanceof Element ? document.activeElement : null;
    // Keep focus on the field being dictated into — the badge must never
    // steal focus from the text field.
    event.preventDefault();
    this.dragging = true;
    this.dragMoved = false;
    this.activePointerId = event.pointerId;
    this.startClient = { x: event.clientX, y: event.clientY };
    const rect = this.host.getBoundingClientRect();
    this.startHost = { x: rect.left, y: rect.top };
    // Anchor to left/top so the default right/center placement cannot fight
    // the drag.
    this.applyPosition({ x: rect.left, y: rect.top });
    this.badge?.classList.add('dragging');
    try {
      this.host.setPointerCapture(event.pointerId);
    } catch {
      /* capture unsupported — moves still land on the host in practice */
    }
  }

  private onPointerMove(event: PointerEvent): void {
    if (!this.dragging || event.pointerId !== this.activePointerId) return;
    const dx = event.clientX - this.startClient.x;
    const dy = event.clientY - this.startClient.y;
    if (!this.dragMoved && Math.hypot(dx, dy) <= DRAG_THRESHOLD_PX) return;
    this.dragMoved = true;
    const position = this.clampPosition({ x: this.startHost.x + dx, y: this.startHost.y + dy });
    this.applyPosition(position);
  }

  private onPointerUp(event: PointerEvent): void {
    if (!this.dragging || event.pointerId !== this.activePointerId) return;
    const capturedFocus = this.pointerDownFocus;
    this.endDrag();
    if (this.dragMoved) {
      this.pointerDownFocus = null;
      void saveBadgePosition({ ...this.appliedPosition });
      return;
    }
    this.pointerDownFocus = null;
    this.onToggle(capturedFocus); // plain click — start/stop dictation with pre-blur focus
  }

  private onMouseDown(event: MouseEvent): void {
    if (!this.visible || !this.host) return;
    if (event.button !== 0) return;
    // Fallback for browsers/devices that emit mousedown without pointerdown —
    // capture focus here as well before the blur.
    if (!this.pointerDownFocus) {
      this.pointerDownFocus = document.activeElement instanceof Element ? document.activeElement : null;
    }
    // Prevent the mousedown default that blurs the focused input/editable.
    event.preventDefault();
  }

  private endDrag(): void {
    this.dragging = false;
    this.activePointerId = undefined;
    this.badge?.classList.remove('dragging');
  }

  private onPointerCancel(): void {
    this.pointerDownFocus = null;
    this.endDrag();
  }

  private clampPosition(position: { x: number; y: number }): { x: number; y: number } {
    const width = this.host?.offsetWidth || 38;
    const height = this.host?.offsetHeight || 38;
    const maxX = Math.max(0, window.innerWidth - width);
    const maxY = Math.max(0, window.innerHeight - height);
    return {
      x: Math.min(Math.max(0, position.x), maxX),
      y: Math.min(Math.max(0, position.y), maxY),
    };
  }

  private applyPosition(position: { x: number; y: number }): void {
    const host = this.host;
    if (!host) return;
    this.appliedPosition = { x: position.x, y: position.y };
    host.style.left = `${position.x}px`;
    host.style.top = `${position.y}px`;
    host.style.right = 'auto';
    host.style.transform = 'none';
  }

  // ---- host ------------------------------------------------------------------

  private ensureHost(): void {
    if (this.host?.isConnected) return;
    const existing = document.getElementById('__voice-type-status-host');
    if (existing instanceof HTMLDivElement) {
      this.host = existing;
      const shadow = existing.shadowRoot;
      this.badge = shadow?.querySelector('.badge') ?? null;
      this.noteBubble = shadow?.querySelector('.note') ?? null;
      this.wirePointerHandlers(existing);
      return;
    }
    const host = document.createElement('div');
    host.id = '__voice-type-status-host';
    // Default spot: right edge, a little distance from it, vertically centered.
    host.style.cssText =
      'all: initial; position: fixed; right: 12px; top: 50%; transform: translateY(-50%); z-index: 2147483647; display: none;';
    const shadow = host.attachShadow({ mode: 'open' });
    shadow.innerHTML = BADGE_HTML; // static template only — never transcript data
    this.badge = shadow.querySelector('.badge');
    this.noteBubble = shadow.querySelector('.note');
    (document.documentElement ?? document.body).appendChild(host);
    this.host = host;
    this.wirePointerHandlers(host);
    this.host.style.display = this.visible ? 'block' : 'none';
  }

  private wirePointerHandlers(host: HTMLDivElement): void {
    if (host.dataset.vtPointerWired === '1') return;
    host.dataset.vtPointerWired = '1';
    // The badge is a floating overlay: its interactions must never leak into
    // the host page. Editors like Google Keep run document-level
    // pointer/click handlers (outside-click detection, editor activation) —
    // a bubbling badge press registered as a click on the page, closing or
    // re-rendering the note mid-dictation, which scrambled the captured caret
    // (duplicated words, text inserted at the wrong position). Shadow DOM
    // isolates the badge's styling; this isolates its events. The badge's own
    // listeners below are on the same element, so stopPropagation here does
    // not affect them.
    for (const type of [
      'pointerdown',
      'pointermove',
      'pointerup',
      'pointercancel',
      'mousedown',
      'mouseup',
      'click',
      'dblclick',
      'auxclick',
      'contextmenu',
      'touchstart',
      'touchend',
    ]) {
      host.addEventListener(type, (event) => event.stopPropagation());
    }
    host.addEventListener('pointerdown', (event) => this.onPointerDown(event));
    host.addEventListener('pointermove', (event) => this.onPointerMove(event));
    host.addEventListener('pointerup', (event) => this.onPointerUp(event));
    host.addEventListener('pointercancel', () => this.onPointerCancel());
    host.addEventListener('mousedown', (event) => this.onMouseDown(event));
  }
}
