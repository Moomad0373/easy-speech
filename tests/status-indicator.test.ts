import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { StatusIndicator } from '../src/content/StatusIndicator';
import { loadBadgePosition, saveBadgePosition } from '../src/shared/storage';
import type { RecognitionStatus } from '../src/shared/types';

vi.mock('../src/shared/storage', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/shared/storage')>();
  return {
    ...actual,
    loadBadgePosition: vi.fn(async () => null),
    saveBadgePosition: vi.fn(async () => {}),
  };
});

const loadPosition = vi.mocked(loadBadgePosition);
const savePosition = vi.mocked(saveBadgePosition);

function makeStatus(
  state: RecognitionStatus['state'],
  lastError: RecognitionStatus['lastError'] = null
): RecognitionStatus {
  return {
    state,
    language: 'fa-IR',
    mode: 'cloud',
    modeNote: '',
    availability: 'unknown',
    sessionCount: 1,
    restartCount: 0,
    lastEvent: 'none',
    lastError,
    target: null,
    interimTranscript: '',
    lastFinalTranscript: '',
    uncommittedTranscript: null,
    note: null,
    autoRestart: true,
  };
}

function hostElement(): HTMLElement {
  const host = document.getElementById('__voice-type-status-host');
  if (!host) throw new Error('status host missing');
  return host;
}

function badgeElement(): HTMLElement {
  const badge = hostElement().shadowRoot?.querySelector('.badge');
  if (!(badge instanceof HTMLElement)) throw new Error('badge element missing');
  return badge;
}

function pointer(
  type: 'pointerdown' | 'pointermove' | 'pointerup',
  x: number,
  y: number,
  pointerId = 1
): PointerEvent {
  // jsdom may lack the PointerEvent constructor — MouseEvent carries all the
  // fields the handlers actually read (clientX/clientY/pointerId).
  return new MouseEvent(type, { clientX: x, clientY: y, bubbles: true }) as unknown as PointerEvent;
}

describe('StatusIndicator — lifecycle', () => {
  beforeEach(() => {
    document.getElementById('__voice-type-status-host')?.remove();
    loadPosition.mockResolvedValue(null);
    savePosition.mockClear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('stays hidden until dictation becomes active, then appears', () => {
    const indicator = new StatusIndicator();
    indicator.update(makeStatus('idle'));
    expect(hostElement().style.display).toBe('none');

    indicator.update(makeStatus('listening'));
    expect(hostElement().style.display).toBe('block');
    expect(badgeElement().getAttribute('data-state')).toBe('active');

    // Stays visible after dictation stops so it can be reused.
    indicator.update(makeStatus('idle'));
    expect(hostElement().style.display).toBe('block');
    expect(badgeElement().getAttribute('data-state')).toBe('idle');
  });

  it('ignores updates while the pref is disabled', () => {
    const indicator = new StatusIndicator();
    indicator.setEnabled(false);
    indicator.update(makeStatus('listening'));
    expect(hostElement().style.display).toBe('none');

    indicator.setEnabled(true);
    // never summoned → stays hidden until the next active status
    expect(hostElement().style.display).toBe('none');
  });

  it('applies the latest known state when re-enabled after being summoned', () => {
    const indicator = new StatusIndicator();
    indicator.update(makeStatus('listening'));
    indicator.setEnabled(false);
    indicator.setEnabled(true);
    expect(hostElement().style.display).toBe('block');
    expect(badgeElement().getAttribute('data-state')).toBe('active');
  });

  it('marks the error state and surfaces the human-readable message', () => {
    const indicator = new StatusIndicator();
    indicator.update(makeStatus('listening'));
    indicator.update(
      makeStatus('error', { code: 'not-allowed', message: 'Microphone permission was denied.' })
    );
    expect(badgeElement().getAttribute('data-state')).toBe('error');
    expect(badgeElement().getAttribute('title')).toContain('Microphone permission was denied.');
    expect(badgeElement().getAttribute('aria-label')).toContain(
      'Microphone permission was denied.'
    );
  });

  it('shows a one-off note in the bubble and fades it again', () => {
    vi.useFakeTimers();
    const indicator = new StatusIndicator();
    indicator.update(makeStatus('listening'));
    const bubble = hostElement().shadowRoot?.querySelector('.note');
    expect(bubble).not.toBeNull();
    // The first update shows the language in the same bubble; let it fade so
    // the note below is observed on its own.
    vi.advanceTimersByTime(2500);
    expect(bubble?.classList.contains('visible')).toBe(false);

    // A transcript was just copied, and the user did not do that.
    indicator.update({ ...makeStatus('idle'), note: 'Transcript copied to clipboard' });
    expect(bubble?.textContent).toBe('Transcript copied to clipboard');
    expect(bubble?.classList.contains('visible')).toBe(true);

    vi.advanceTimersByTime(2500);
    expect(bubble?.classList.contains('visible')).toBe(false);
    vi.useRealTimers();
  });

  it('does not re-show the bubble for the same note on every status update', () => {
    // `note` stays in the status for as long as the session is settled, and the
    // status is broadcast far more often than the note changes. Re-showing on
    // each broadcast would pin the bubble open instead of letting it fade.
    vi.useFakeTimers();
    const indicator = new StatusIndicator();
    indicator.update(makeStatus('listening'));
    const bubble = hostElement().shadowRoot?.querySelector('.note')!;

    indicator.update({ ...makeStatus('idle'), note: 'Transcript copied to clipboard' });
    vi.advanceTimersByTime(2500);
    expect(bubble.classList.contains('visible')).toBe(false);

    indicator.update({ ...makeStatus('idle'), note: 'Transcript copied to clipboard' });
    expect(bubble.classList.contains('visible')).toBe(false);

    // A genuinely different note does show again.
    indicator.update({ ...makeStatus('idle'), note: 'Could not copy to the clipboard' });
    expect(bubble.classList.contains('visible')).toBe(true);
    vi.useRealTimers();
  });

  it('reuses the existing host element across instances', () => {
    const first = new StatusIndicator();
    first.update(makeStatus('listening'));
    const before = hostElement();
    const second = new StatusIndicator();
    second.update(makeStatus('listening'));
    expect(hostElement()).toBe(before);
  });
});

describe('StatusIndicator — click and drag', () => {
  beforeEach(() => {
    document.getElementById('__voice-type-status-host')?.remove();
    loadPosition.mockResolvedValue(null);
    savePosition.mockClear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function summonBadge(onToggle = vi.fn()): StatusIndicator {
    const indicator = new StatusIndicator({ onToggle });
    indicator.update(makeStatus('listening'));
    return indicator;
  }

  it('toggles dictation on a plain click (press + release, no move)', () => {
    const onToggle = vi.fn();
    summonBadge(onToggle);
    const host = hostElement();

    host.dispatchEvent(pointer('pointerdown', 10, 10));
    host.dispatchEvent(pointer('pointerup', 10, 10));
    expect(onToggle).toHaveBeenCalledTimes(1);
  });

  it('does NOT toggle when the pointer moved beyond the drag threshold', () => {
    const onToggle = vi.fn();
    summonBadge(onToggle);
    const host = hostElement();

    host.dispatchEvent(pointer('pointerdown', 10, 10));
    host.dispatchEvent(pointer('pointermove', 60, 60));
    host.dispatchEvent(pointer('pointerup', 60, 60));
    expect(onToggle).not.toHaveBeenCalled();
  });

  it('moves the badge with the pointer and persists the final position', () => {
    summonBadge();
    const host = hostElement();

    host.dispatchEvent(pointer('pointerdown', 100, 100));
    host.dispatchEvent(pointer('pointermove', 140, 90));
    host.dispatchEvent(pointer('pointerup', 140, 90));

    // jsdom has no layout — rects are 0-sized, so the anchor is (0,0) and the
    // clamped position equals the raw delta (y cannot go below 0).
    expect(host.style.left).toBe('40px');
    expect(host.style.top).toBe('0px');
    expect(savePosition).toHaveBeenCalledWith({ x: 40, y: 0 });
  });

  it('saves the position only after a real drag, not a click', () => {
    summonBadge();
    const host = hostElement();

    host.dispatchEvent(pointer('pointerdown', 10, 10));
    host.dispatchEvent(pointer('pointerup', 10, 10));
    expect(savePosition).not.toHaveBeenCalled();
  });

  it('restores the saved position when shown', async () => {
    loadPosition.mockResolvedValue({ x: 222, y: 111 });
    summonBadge();
    await vi.waitFor(() => {
      expect(hostElement().style.left).toBe('222px');
      expect(hostElement().style.top).toBe('111px');
    });
  });

  it('ignores pointer events while hidden', () => {
    const onToggle = vi.fn();
    new StatusIndicator({ onToggle });
    const host = hostElement(); // exists but display: none

    host.dispatchEvent(pointer('pointerdown', 5, 5));
    host.dispatchEvent(pointer('pointerup', 5, 5));
    expect(onToggle).not.toHaveBeenCalled();
  });

  it('centers the badge on the right edge by default', () => {
    summonBadge();
    const host = hostElement();
    expect(host.style.cssText).toContain('right: 12px');
    expect(host.style.cssText).toContain('top: 50%');
  });

  it('never leaks badge pointer/click events into the host page', () => {
    summonBadge();
    const host = hostElement();

    // Editors like Google Keep attach document-level listeners; a badge press
    // must not register as a page click (it used to close/re-render the note
    // mid-dictation and scramble the captured caret).
    const types = [
      'pointerdown',
      'pointerup',
      'mousedown',
      'mouseup',
      'click',
      'dblclick',
      'contextmenu',
      'touchstart',
      'touchend',
    ] as const;
    const leaked: string[] = [];
    const spy = (event: Event): void => {
      leaked.push(event.type);
    };
    for (const type of types) document.addEventListener(type, spy);

    host.dispatchEvent(pointer('pointerdown', 10, 10));
    host.dispatchEvent(pointer('pointerup', 10, 10));
    for (const type of ['mousedown', 'mouseup', 'click', 'dblclick', 'contextmenu', 'touchstart', 'touchend']) {
      host.dispatchEvent(new MouseEvent(type, { bubbles: true }));
    }

    for (const type of types) document.removeEventListener(type, spy);
    expect(leaked).toEqual([]);
  });

  it('still toggles dictation with its own handlers after event isolation', () => {
    const onToggle = vi.fn();
    summonBadge(onToggle);
    const host = hostElement();

    host.dispatchEvent(pointer('pointerdown', 3, 3));
    host.dispatchEvent(pointer('pointerup', 3, 3));
    expect(onToggle).toHaveBeenCalledTimes(1);
  });
});
