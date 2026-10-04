import type { CustomVoiceCommand, Language } from '../../shared/types';

/**
 * Voice commands (spec §40): spoken phrases that are executed as punctuation
 * or formatting instead of being typed (modeled after Voice In's command
 * tables). Matching is token-exact after normalization — ordinary words are
 * never rewritten. User-defined custom commands (settings page) are matched
 * first and override the built-ins.
 *
 * Spacing modes:
 * - 'before': symbol hugs the PREVIOUS word ("سلام ویرگول" → "سلام،")
 * - 'after':  symbol hugs the NEXT word ("پرانتز باز سلام" → "(سلام")
 * - 'both':   symbol hugs both sides ("ali at sign gmail" → "ali@gmail")
 * - 'block':  formatting replacement ("خط جدید" → line break, spaces trimmed)
 * - 'none':   replacement inserted as-is, surrounding spaces preserved
 *             (custom text commands), except punctuation-only replacements
 *             (≤ 2 chars without letters/digits) which hug the previous word,
 *             and empty replacements (mute) which drop the preceding space.
 */
export type VoiceCommandSpacing = 'before' | 'after' | 'both' | 'block' | 'none';

export interface VoiceCommand {
  replace: string;
  spacing: VoiceCommandSpacing;
}

/** Longest built-in spoken phrase ("close single quote") spans 3 words. */
const BASE_MAX_COMMAND_WORDS = 3;
/** Custom phrases may be longer; this is the hard matching ceiling. */
const MAX_CUSTOM_WORDS = 12;

const BEFORE = (replace: string): VoiceCommand => ({ replace, spacing: 'before' });
const AFTER = (replace: string): VoiceCommand => ({ replace, spacing: 'after' });
const BOTH = (replace: string): VoiceCommand => ({ replace, spacing: 'both' });
const BLOCK = (replace: string): VoiceCommand => ({ replace, spacing: 'block' });

/**
 * Built-in spoken-command tables per language. Only Persian and English ship
 * tables today; every other catalog language degrades to plain dictation plus
 * the user's own custom commands (which work in all languages), so the lookup
 * must tolerate missing keys.
 */
const COMMAND_TABLES: Partial<Record<Language, Record<string, VoiceCommand>>> = {
  'fa-IR': {
    نقطه: BEFORE('.'),
    'نقطه ویرگول': BEFORE('؛'),
    ویرگول: BEFORE('،'),
    کاما: BEFORE('،'),
    'علامت سوال': BEFORE('؟'),
    'علامت سؤال': BEFORE('؟'),
    'علامت تعجب': BEFORE('!'),
    'سه نقطه': BEFORE('…'),
    دونقطه: BEFORE(':'),
    'دو نقطه': BEFORE(':'),
    'خط تیره': BOTH('-'),
    'خط تیره بلند': BEFORE('—'),
    'پرانتز باز': AFTER('('),
    'پرانتز بسته': BEFORE(')'),
    'کروشه باز': AFTER('['),
    'کروشه بسته': BEFORE(']'),
    'آکولاد باز': AFTER('{'),
    'آکولاد بسته': BEFORE('}'),
    'گیومه باز': AFTER('«'),
    'گیومه بسته': BEFORE('»'),
    'نقل قول باز': AFTER('"'),
    'نقل قول بسته': BEFORE('"'),
    ات: BOTH('@'),
    اسلش: BOTH('/'),
    'بک اسلش': BOTH('\\'),
    ستاره: BOTH('*'),
    'علامت درصد': BOTH('%'),
    'علامت شارپ': BOTH('#'),
    'علامت دلار': BOTH('$'),
    'علامت جمع': BOTH('+'),
    'علامت مساوی': BOTH('='),
    امپرسند: BOTH('&'),
    'کمتر از': BOTH('<'),
    'بیشتر از': BOTH('>'),
    'خط جدید': BLOCK('\n'),
    'سطر جدید': BLOCK('\n'),
    'پاراگراف جدید': BLOCK('\n\n'),
  },
  'en-US': {
    period: BEFORE('.'),
    'full stop': BEFORE('.'),
    dot: BOTH('.'),
    comma: BEFORE(','),
    'question mark': BEFORE('?'),
    'exclamation mark': BEFORE('!'),
    'exclamation point': BEFORE('!'),
    colon: BEFORE(':'),
    semicolon: BEFORE(';'),
    ellipsis: BEFORE('…'),
    hyphen: BOTH('-'),
    dash: BEFORE('—'),
    'open paren': AFTER('('),
    'open parenthesis': AFTER('('),
    'close paren': BEFORE(')'),
    'close parenthesis': BEFORE(')'),
    'open bracket': AFTER('['),
    'close bracket': BEFORE(']'),
    'open brace': AFTER('{'),
    'close brace': BEFORE('}'),
    'open quote': AFTER('"'),
    'close quote': BEFORE('"'),
    'open single quote': AFTER("'"),
    'close single quote': BEFORE("'"),
    'at sign': BOTH('@'),
    'percent sign': BOTH('%'),
    'plus sign': BOTH('+'),
    'equals sign': BOTH('='),
    'dollar sign': BOTH('$'),
    'hash sign': BOTH('#'),
    'number sign': BOTH('#'),
    ampersand: BOTH('&'),
    asterisk: BOTH('*'),
    slash: BOTH('/'),
    backslash: BOTH('\\'),
    'caret sign': BOTH('^'),
    'tilde sign': BOTH('~'),
    pipe: BOTH('|'),
    'less than': BOTH('<'),
    'greater than': BOTH('>'),
    'new line': BLOCK('\n'),
    'new paragraph': BLOCK('\n\n'),
  },
};

/** Case/ZWNJ/Arabic-variant-insensitive form used for matching only. */
function normalizeToken(token: string): string {
  return token
    .toLowerCase()
    .replace(/[\u200c\u200f\u200e]/g, '')
    .replace(/\u064a/g, '\u06cc') // Arabic yeh → Persian yeh
    .replace(/\u0643/g, '\u06a9'); // Arabic kaf → Persian kaf
}

/** User-written replacements may contain escaped control characters. */
function interpretEscapes(text: string): string {
  return text.replace(/\\n/g, '\n').replace(/\\t/g, '\t');
}

/**
 * Chooses the spacing behavior for a custom replacement: empty → mute the
 * phrase (drops the preceding space so words join normally), punctuation-only
 * → hugs the previous word, anything else → verbatim with surrounding spaces
 * preserved.
 */
function customSpacing(replacement: string): VoiceCommandSpacing {
  if (replacement === '') return 'before';
  const core = replacement.trim();
  if (core.length > 0 && core.length <= 2 && !/[\p{L}\p{N}]/u.test(core)) return 'before';
  return 'none';
}

/** Builds the custom lookup (normalized phrase → command, first one wins). */
function buildCustomTable(
  custom: CustomVoiceCommand[]
): { table: Record<string, VoiceCommand>; maxWords: number } {
  const table: Record<string, VoiceCommand> = Object.create(null);
  let maxWords = 0;
  for (const entry of custom) {
    const words = normalizeToken(entry.phrase).split(/\s+/).filter(Boolean);
    if (words.length === 0 || words.length > MAX_CUSTOM_WORDS) continue;
    const key = words.join(' ');
    if (table[key]) continue;
    const replacement = interpretEscapes(entry.replacement);
    table[key] = { replace: replacement, spacing: customSpacing(replacement) };
    maxWords = Math.max(maxWords, words.length);
  }
  return { table, maxWords };
}

/**
 * Rewrites spoken commands in `text` into their punctuation/formatting
 * counterparts. Unrecognized words pass through untouched, so a disabled or
 * partial match degrades to plain dictation.
 */
export function applyVoiceCommands(text: string, language: Language, custom: CustomVoiceCommand[] = []): string {
  const customTable = custom.length > 0 ? buildCustomTable(custom) : null;
  const builtIn = COMMAND_TABLES[language] ?? {};
  const commands: Record<string, VoiceCommand> = customTable
    ? { ...builtIn, ...customTable.table }
    : builtIn;
  if (text.length === 0 || Object.keys(commands).length === 0) return text;

  const maxCommandWords = customTable
    ? Math.max(BASE_MAX_COMMAND_WORDS, customTable.maxWords)
    : BASE_MAX_COMMAND_WORDS;

  // Split into words and whitespace runs, preserving everything so the
  // original spacing outside commands survives.
  const tokens = text.split(/(\s+)/);
  const isWord = (token: string | undefined): boolean => !!token && !/^\s+$/.test(token);

  for (let i = 0; i < tokens.length; i++) {
    if (!isWord(tokens[i])) continue;

    // Collect this word and up to maxCommandWords - 1 following words.
    const wordIndices: number[] = [];
    let scan = i;
    while (scan < tokens.length && wordIndices.length < maxCommandWords) {
      if (isWord(tokens[scan])) wordIndices.push(scan);
      scan += 1;
    }

    for (let length = wordIndices.length; length >= 1; length--) {
      const phrase = wordIndices
        .slice(0, length)
        .map((index) => normalizeToken(tokens[index] ?? ''))
        .join(' ');
      if (!Object.prototype.hasOwnProperty.call(commands, phrase)) continue;
      const command = commands[phrase]!;

      const firstIndex = wordIndices[0];
      const lastIndex = wordIndices[length - 1];
      tokens[firstIndex] = command.replace;
      for (let k = firstIndex + 1; k <= lastIndex; k++) tokens[k] = '';

      // Hug the symbol per its spacing mode by dropping adjacent spaces.
      const prev = firstIndex - 1;
      const next = lastIndex + 1;
      if (
        (command.spacing === 'before' || command.spacing === 'both' || command.spacing === 'block') &&
        prev >= 0 &&
        /^\s+$/.test(tokens[prev] ?? '')
      ) {
        tokens[prev] = '';
      }
      if (
        (command.spacing === 'after' || command.spacing === 'both' || command.spacing === 'block') &&
        next < tokens.length &&
        /^\s+$/.test(tokens[next] ?? '')
      ) {
        tokens[next] = '';
      }

      i = lastIndex; // continue scanning after the consumed phrase
      break;
    }
  }

  return tokens.join('');
}
