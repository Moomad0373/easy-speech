import { describe, expect, it } from 'vitest';
import {
  DEFAULT_LANGUAGE_SHORTCUT,
  formatShortcut,
  isModifierCode,
  isValidShortcut,
  matchesShortcut,
  sanitizeShortcut,
  shortcutFromEvent,
  type ShortcutSpec,
} from '../src/shared/shortcut';

function event(
  overrides: Partial<{
    code: string;
    key: string;
    ctrlKey: boolean;
    altKey: boolean;
    shiftKey: boolean;
    metaKey: boolean;
  }> = {}
): KeyboardEvent {
  return {
    code: 'KeyL',
    key: 'l',
    ctrlKey: false,
    altKey: true,
    shiftKey: false,
    metaKey: false,
    ...overrides,
  } as KeyboardEvent;
}

const ctrlJ: ShortcutSpec = {
  code: 'KeyJ',
  key: 'j',
  ctrl: true,
  alt: false,
  shift: false,
  meta: false,
};

describe('shortcutFromEvent', () => {
  it('builds a spec from a valid combination', () => {
    expect(shortcutFromEvent(event({ code: 'KeyJ', key: 'j', ctrlKey: true, altKey: false }))).toEqual(ctrlJ);
  });

  it('rejects bare modifier keys', () => {
    expect(shortcutFromEvent(event({ code: 'ShiftLeft', key: 'Shift' }))).toBeNull();
    expect(shortcutFromEvent(event({ code: 'ControlLeft', key: 'Control', ctrlKey: true }))).toBeNull();
  });

  it('rejects combinations without Ctrl/Alt/⌘ (Shift alone would collide with typing)', () => {
    expect(shortcutFromEvent(event({ altKey: false, shiftKey: true }))).toBeNull();
  });

  it('rejects empty code', () => {
    expect(shortcutFromEvent(event({ code: '' }))).toBeNull();
  });
});

describe('matchesShortcut', () => {
  it('requires the exact physical key and modifier set', () => {
    expect(matchesShortcut(event({ shiftKey: true }), DEFAULT_LANGUAGE_SHORTCUT)).toBe(true);
    expect(matchesShortcut(event({ code: 'KeyK', key: 'k', shiftKey: true }), DEFAULT_LANGUAGE_SHORTCUT)).toBe(false);
    expect(matchesShortcut(event({ shiftKey: false }), DEFAULT_LANGUAGE_SHORTCUT)).toBe(false);
    expect(matchesShortcut(event({ shiftKey: true, ctrlKey: true }), DEFAULT_LANGUAGE_SHORTCUT)).toBe(false);
  });

  it('is code-based, so layout changes keep the shortcut alive', () => {
    // Same physical key, different character produced (e.g. switched layout).
    expect(matchesShortcut(event({ key: '÷', shiftKey: true }), DEFAULT_LANGUAGE_SHORTCUT)).toBe(true);
  });
});

describe('sanitizeShortcut', () => {
  it('passes through a valid spec with normalized booleans', () => {
    expect(sanitizeShortcut(ctrlJ)).toEqual(ctrlJ);
  });

  it('returns null for invalid shapes and unusable combos', () => {
    expect(sanitizeShortcut(null)).toBeNull();
    expect(sanitizeShortcut(undefined)).toBeNull();
    expect(sanitizeShortcut('Alt+Shift+L')).toBeNull();
    expect(sanitizeShortcut({ code: 'KeyL', key: 'l' })).toBeNull(); // no modifier
    expect(sanitizeShortcut({ code: 'ShiftLeft', key: 'Shift', shift: true })).toBeNull();
  });

  it('accepts meta-only combos', () => {
    expect(
      sanitizeShortcut({ code: 'KeyP', key: 'p', ctrl: false, alt: false, shift: false, meta: true })
    ).toEqual({ code: 'KeyP', key: 'p', ctrl: false, alt: false, shift: false, meta: true });
  });
});

describe('isValidShortcut / isModifierCode', () => {
  it('flags modifier codes and validates specs', () => {
    expect(isModifierCode('AltRight')).toBe(true);
    expect(isModifierCode('KeyL')).toBe(false);
    expect(isValidShortcut(ctrlJ)).toBe(true);
    expect(isValidShortcut({})).toBe(false);
  });
});

describe('formatShortcut', () => {
  it('renders modifiers in canonical order', () => {
    expect(formatShortcut(DEFAULT_LANGUAGE_SHORTCUT)).toBe('Alt + Shift + L');
    expect(formatShortcut(ctrlJ)).toBe('Ctrl + J');
    expect(
      formatShortcut({ code: 'Digit1', key: '1', ctrl: true, alt: true, shift: true, meta: true })
    ).toBe('Ctrl + Alt + Shift + Win + 1');
    expect(formatShortcut({ code: 'Space', key: ' ', ctrl: true, alt: false, shift: false, meta: false })).toBe(
      'Ctrl + Space'
    );
  });
});

describe('formatShortcut platform detection (⌘ vs Win)', () => {
  const metaCombo: ShortcutSpec = {
    code: 'KeyP',
    key: 'p',
    ctrl: false,
    alt: false,
    shift: false,
    meta: true,
  };

  function setUserAgentData(platform: string | undefined): void {
    if (platform === undefined) {
      Reflect.deleteProperty(navigator, 'userAgentData');
      return;
    }
    Object.defineProperty(navigator, 'userAgentData', {
      value: { platform },
      configurable: true,
    });
  }

  it('shows ⌘ when User-Agent Client Hints report macOS', () => {
    setUserAgentData('macOS');
    try {
      expect(formatShortcut(metaCombo)).toBe('⌘ + P');
    } finally {
      setUserAgentData(undefined);
    }
  });

  it('shows Win when User-Agent Client Hints report Windows', () => {
    setUserAgentData('Windows');
    try {
      expect(formatShortcut(metaCombo)).toBe('Win + P');
    } finally {
      setUserAgentData(undefined);
    }
  });

  it('falls back to the user-agent string when client hints are absent', () => {
    // jsdom has no userAgentData and its UA contains no Apple marker.
    expect(formatShortcut(metaCombo)).toBe('Win + P');
  });
});
