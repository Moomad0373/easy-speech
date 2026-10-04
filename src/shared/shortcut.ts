/**
 * User-definable in-page keyboard shortcut for cycling the bookmarked
 * languages. Chrome's commands API does not allow assigning keys
 * programmatically (only chrome://extensions/shortcuts can), so the Settings
 * page records a combo with a key recorder, stores it in prefs, and content
 * scripts match keydown events against it to trigger the language cycle.
 *
 * Matching is based on `event.code` (the physical key), so the shortcut keeps
 * working when the user changes their keyboard layout. A shortcut must
 * include Ctrl, Alt or ⌘/Win so plain typing (and Shift+letter) can never
 * trigger it by accident.
 */

/** Normalized description of a key combination. */
export interface ShortcutSpec {
  /** Physical key code, e.g. "KeyL", "Digit1" (primary match target). */
  code: string;
  /** `event.key` at record time — used for display only. */
  key: string;
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
  meta: boolean;
}

const MODIFIER_CODES = new Set([
  'ControlLeft',
  'ControlRight',
  'AltLeft',
  'AltRight',
  'ShiftLeft',
  'ShiftRight',
  'MetaLeft',
  'MetaRight',
  'OSLeft',
  'OSRight',
]);

/** Default mirrors the manifest's suggested_key for `cycle-language`. */
export const DEFAULT_LANGUAGE_SHORTCUT: ShortcutSpec = {
  code: 'KeyL',
  key: 'l',
  ctrl: false,
  alt: true,
  shift: true,
  meta: false,
};

export function isModifierCode(code: string): boolean {
  return MODIFIER_CODES.has(code);
}

/** True when the spec is a recordable, non-ambiguous combo. */
export function isValidShortcut(value: unknown): value is ShortcutSpec {
  const spec = value as Partial<ShortcutSpec> | null | undefined;
  if (!spec || typeof spec !== 'object') return false;
  if (typeof spec.code !== 'string' || spec.code.length === 0) return false;
  if (typeof spec.key !== 'string' || spec.key.length === 0) return false;
  if (isModifierCode(spec.code)) return false;
  // Shift alone is not enough: Shift+letter collides with normal typing.
  return Boolean(spec.ctrl || spec.alt || spec.meta);
}

/**
 * Validates an untrusted (storage / message payload) shortcut value.
 * Returns null for anything that is not a usable combo, including null
 * itself (null is the "disabled" state).
 */
export function sanitizeShortcut(value: unknown): ShortcutSpec | null {
  if (!isValidShortcut(value)) return null;
  const spec = value as ShortcutSpec;
  return {
    code: spec.code,
    key: spec.key,
    ctrl: spec.ctrl === true,
    alt: spec.alt === true,
    shift: spec.shift === true,
    meta: spec.meta === true,
  };
}

/**
 * Builds a spec from a captured KeyboardEvent, or null when the event is a
 * bare modifier key or lacks a required Ctrl/Alt/⌘ modifier.
 */
export function shortcutFromEvent(event: Pick<KeyboardEvent, 'code' | 'key' | 'ctrlKey' | 'altKey' | 'shiftKey' | 'metaKey'>): ShortcutSpec | null {
  if (!event.code || isModifierCode(event.code)) return null;
  const spec: ShortcutSpec = {
    code: event.code,
    key: event.key,
    ctrl: event.ctrlKey,
    alt: event.altKey,
    shift: event.shiftKey,
    meta: event.metaKey,
  };
  return isValidShortcut(spec) ? spec : null;
}

/** True when a keydown event matches the stored combo exactly. */
export function matchesShortcut(
  event: Pick<KeyboardEvent, 'code' | 'ctrlKey' | 'altKey' | 'shiftKey' | 'metaKey'>,
  spec: ShortcutSpec
): boolean {
  return (
    event.code === spec.code &&
    event.ctrlKey === spec.ctrl &&
    event.altKey === spec.alt &&
    event.shiftKey === spec.shift &&
    event.metaKey === spec.meta
  );
}

function isApplePlatform(): boolean {
  try {
    // User-Agent Client Hints are the supported signal; navigator.platform is
    // deprecated. userAgentData is Chromium-only (undefined in jsdom/other
    // browsers) — fall back to the UA string, matching the old behavior.
    const uaData = (navigator as Navigator & { userAgentData?: { platform?: string } })
      .userAgentData;
    return /Mac|iPhone|iPad/i.test(uaData?.platform || navigator.userAgent);
  } catch {
    return false;
  }
}

function keyLabel(spec: ShortcutSpec): string {
  const named: Record<string, string> = {
    ' ': 'Space',
    ArrowUp: '↑',
    ArrowDown: '↓',
    ArrowLeft: '←',
    ArrowRight: '→',
    Escape: 'Esc',
    Backquote: '`',
    Minus: '-',
    Equal: '=',
    BracketLeft: '[',
    BracketRight: ']',
    Semicolon: ';',
    Quote: "'",
    Comma: ',',
    Period: '.',
    Slash: '/',
    Backslash: '\\',
  };
  if (spec.key in named) return named[spec.key]!;
  if (spec.key.length === 1) return spec.key.toUpperCase();
  return spec.key;
}

/** Human-readable combo, e.g. "Alt + Shift + L" or "Ctrl + ⌘ + P". */
export function formatShortcut(spec: ShortcutSpec): string {
  const parts: string[] = [];
  if (spec.ctrl) parts.push('Ctrl');
  if (spec.alt) parts.push('Alt');
  if (spec.shift) parts.push('Shift');
  if (spec.meta) parts.push(isApplePlatform() ? '⌘' : 'Win');
  parts.push(keyLabel(spec));
  return parts.join(' + ');
}
