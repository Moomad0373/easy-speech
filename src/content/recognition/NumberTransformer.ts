import type { Language } from '../../shared/types';

/**
 * NumberTransformer (spec §41): optional "always type numbers as digits".
 * Converts spoken number words ("twenty five", «بیست و پنج») into digits
 * ("25") in final transcripts. Language-aware compound parser over whitespace
 * tokens — no regex replacement:
 *
 * - Whole-word matching only, so existing digits are never touched ("3.5",
 *   "2026/05/01", "217-652-8632", "۲۵", "ID 45" pass through unchanged).
 * - Compounds: juxtaposition ("six hundred" → 600), scale words
 *   (thousand/million/billion, هزار/میلیون/میلیارد), and the و/and connector,
 *   which continues a number only while magnitudes descend (بیست و پنج → 25,
 *   دو هزار و بیست و شش → 2026) — "between five and six" keeps its و.
 * - Persian «نه» is a digit only inside a larger number («نود و نه» → 99);
 *   alone it is the word "no" and is left untouched.
 */
interface NumberWord {
  /** Value for unit/teen/tens words. */
  value?: number;
  /** Multiplier for scale words (hundred, thousand, …). */
  scale?: number;
  /** Magnitude rank used by the و/and continuation rule. */
  rank: number;
  connector?: boolean;
  /** Ambiguous standalone word (Persian «نه» = 9 or "no"). */
  ambiguous?: boolean;
}

const RANK_UNIT = 1;
const RANK_TENS = 2;
const RANK_HUNDRED = 3;
const RANK_THOUSAND = 4;
const RANK_MILLION = 5;
const RANK_BILLION = 6;

function units(value: number): NumberWord {
  return { value, rank: value < 20 ? RANK_UNIT : RANK_TENS };
}

function scaleWord(scale: number): NumberWord {
  const rank =
    scale >= 1_000_000_000
      ? RANK_BILLION
      : scale >= 1_000_000
        ? RANK_MILLION
        : scale >= 1_000
          ? RANK_THOUSAND
          : RANK_HUNDRED;
  return { scale, rank };
}

const CONNECTOR: NumberWord = { rank: 0, connector: true };

const ENGLISH_WORDS: Record<string, NumberWord> = {
  zero: units(0),
  one: units(1),
  two: units(2),
  three: units(3),
  four: units(4),
  five: units(5),
  six: units(6),
  seven: units(7),
  eight: units(8),
  nine: units(9),
  ten: units(10),
  eleven: units(11),
  twelve: units(12),
  thirteen: units(13),
  fourteen: units(14),
  fifteen: units(15),
  sixteen: units(16),
  seventeen: units(17),
  eighteen: units(18),
  nineteen: units(19),
  twenty: units(20),
  thirty: units(30),
  forty: units(40),
  fifty: units(50),
  sixty: units(60),
  seventy: units(70),
  eighty: units(80),
  ninety: units(90),
  hundred: scaleWord(100),
  thousand: scaleWord(1_000),
  million: scaleWord(1_000_000),
  billion: scaleWord(1_000_000_000),
  and: CONNECTOR,
};

const PERSIAN_WORDS: Record<string, NumberWord> = {
  صفر: units(0),
  یک: units(1),
  دو: units(2),
  سه: units(3),
  چهار: units(4),
  پنج: units(5),
  شش: units(6),
  هفت: units(7),
  هشت: units(8),
  نه: { ...units(9), ambiguous: true },
  ده: units(10),
  یازده: units(11),
  دوازده: units(12),
  سیزده: units(13),
  چهارده: units(14),
  پانزده: units(15),
  پونزده: units(15),
  شانزده: units(16),
  شونزده: units(16),
  هفده: units(17),
  هجده: units(18),
  نوزده: units(19),
  بیست: units(20),
  سی: units(30),
  چهل: units(40),
  پنجاه: units(50),
  شصت: units(60),
  هفتاد: units(70),
  هشتاد: units(80),
  نود: units(90),
  صد: scaleWord(100),
  یکصد: scaleWord(100),
  دویست: units(200),
  سیصد: units(300),
  چهارصد: units(400),
  پانصد: units(500),
  ششصد: units(600),
  هفتصد: units(700),
  هشتصد: units(800),
  نهصد: units(900),
  هزار: scaleWord(1_000),
  میلیون: scaleWord(1_000_000),
  میلیارد: scaleWord(1_000_000_000),
  و: CONNECTOR,
};

/** Only Persian and English ship word tables; other languages are a no-op. */
const WORD_TABLES: Partial<Record<Language, Record<string, NumberWord>>> = {
  'fa-IR': PERSIAN_WORDS,
  'en-US': ENGLISH_WORDS,
};

/**
 * Locale families that share one table: en-GB, en-AU and the other English
 * locales recognize the same number words as en-US, so every en-* locale
 * falls back to the English table (same for fa-*). Without this, «twenty-five»
 * spoken in English (UK) stayed words instead of becoming 25.
 */
const FAMILY_TABLES: Record<string, Language> = { en: 'en-US', fa: 'fa-IR' };

function wordTable(language: Language): Record<string, NumberWord> | undefined {
  const exact = WORD_TABLES[language];
  if (exact) return exact;
  const family = FAMILY_TABLES[language.split('-')[0] ?? ''];
  return family !== undefined ? WORD_TABLES[family] : undefined;
}

/** Persian hundreds (دویست…) are value words but rank like صد. */
const HUNDRED_VALUES = new Set([200, 300, 400, 500, 600, 700, 800, 900]);

function rankOf(entry: NumberWord): number {
  if (entry.value !== undefined && HUNDRED_VALUES.has(entry.value)) return RANK_HUNDRED;
  return entry.rank;
}

function normalizeWord(token: string): string {
  return token
    .toLowerCase()
    .replace(/[\u200c\u200f\u200e]/g, '')
    .replace(/\u064a/g, '\u06cc') // Arabic yeh → Persian yeh
    .replace(/\u0643/g, '\u06a9'); // Arabic kaf → Persian kaf
}

interface BufferEntry {
  index: number;
  entry: NumberWord;
  /** Punctuation glued to the token before/after the word ("(بیست", "هزار،"). */
  prefix: string;
  suffix: string;
}

/** Splits a whitespace-token into leading punctuation, core word, trailing
 *  punctuation. ZWNJ is Cf (not punctuation) so «چهار‌صد» keeps its core. */
function splitToken(token: string): { prefix: string; core: string; suffix: string } {
  const prefixMatch = token.match(/^[\p{P}]+/u);
  const prefix = prefixMatch ? prefixMatch[0] : '';
  const rest = token.slice(prefix.length);
  const suffixMatch = rest.match(/[\p{P}]+$/u);
  const suffix = suffixMatch ? suffixMatch[0] : '';
  const core = rest.slice(0, rest.length - suffix.length);
  return { prefix, core, suffix };
}

function lookupNumberWords(
  core: string,
  words: Record<string, NumberWord>,
  language: Language
): NumberWord[] | null {
  const key = normalizeWord(core);
  if (Object.prototype.hasOwnProperty.call(words, key)) return [words[key]!];
  // Hyphenated English compounds ("twenty-five") — any en-* locale.
  if (language.split('-')[0] !== 'en' || !key.includes('-')) return null;
  const parts = key.split('-');
  if (
    !parts.every((part) => Object.prototype.hasOwnProperty.call(words, part) && !words[part]!.connector)
  ) {
    return null;
  }
  return parts.map((part) => words[part]!);
}

export class NumberTransformer {
  /** Converts spoken number words in `text` to digits; everything else passes
   *  through untouched. Never throws. */
  transform(text: string, language: Language): string {
    const words = wordTable(language);
    if (!words || text.length === 0) return text;

    const tokens = text.split(/(\s+)/);
    const isWord = (token: string | undefined): boolean => !!token && !/^\s+$/.test(token);
    let buffer: BufferEntry[] = [];

    const flush = (): void => {
      if (buffer.length === 0) return;
      const digits = this.bufferToDigits(buffer.map((item) => item.entry));
      if (digits !== null) {
        // The whole buffered span [first..last] collapses into ONE token at
        // the first word's position: its prefix + digits + the LAST word's
        // suffix (so glue like «هزار،» or "(پنج)" survives). Whitespace and
        // word tokens in between are cleared — no double spaces.
        const first = buffer[0]!;
        const last = buffer[buffer.length - 1]!;
        tokens[first.index] = `${first.prefix}${digits}${last.suffix}`;
        for (let k = first.index + 1; k <= last.index; k++) tokens[k] = '';
      }
      buffer = [];
    };

    for (let i = 0; i < tokens.length; i++) {
      const token = tokens[i];
      if (!isWord(token)) {
        if (/[\r\n\u2028\u2029]/.test(token ?? '')) flush();
        continue;
      }
      const { prefix, core, suffix } = splitToken(token);
      if (prefix) flush();
      if (core.length === 0) {
        flush(); // pure punctuation — never part of a number
        continue;
      }
      const entries = lookupNumberWords(core, words, language);
      if (!entries) {
        flush();
        continue;
      }
      const entry = entries[0]!;

      if (entry.connector) {
        // The connector continues the number only while magnitudes descend
        // into the next word (بیست و پنج ✓, بین پنج و شش ✗).
        const next = suffix ? null : this.peekNumberWord(tokens, i + 1, words, language);
        const last = buffer[buffer.length - 1]?.entry;
        if (buffer.length > 0 && last && !last.connector && next && rankOf(last) > rankOf(next)) {
          buffer.push({ index: i, entry, prefix, suffix });
          continue;
        }
        flush();
        continue;
      }

      for (const numberEntry of entries) {
        buffer.push({ index: i, entry: numberEntry, prefix, suffix });
      }
      if (suffix) flush();
    }
    flush();

    return tokens.join('');
  }

  /** Next non-space token's number-word entry (core lookup), or null. */
  private peekNumberWord(
    tokens: string[],
    from: number,
    words: Record<string, NumberWord>,
    language: Language
  ): NumberWord | null {
    for (let i = from; i < tokens.length; i++) {
      const token = tokens[i];
      if (/[\r\n\u2028\u2029]/.test(token ?? '')) return null;
      if (!token || /^\s+$/.test(token)) continue;
      const { prefix, core } = splitToken(token);
      if (prefix || core.length === 0) return null;
      return lookupNumberWords(core, words, language)?.[0] ?? null;
    }
    return null;
  }

  /** Digit string for a run of number words, or null when it is not a
   *  convertible number (e.g. Persian «نه» standing alone).
   *
   *  Magnitude rules: units/teens/tens accumulate into `current`; «صد/hundred»
   *  multiplies the pending units (چهار صد → 400); thousand and larger scales
   *  close a magnitude group into the total (دو هزار → 2000, four hundred
   *  thousand → 400 × 1000 = 400000). */
  private bufferToDigits(entries: NumberWord[]): string | null {
    if (!entries.some((entry) => !entry.connector)) return null;
    if (entries.length === 1 && entries[0]?.ambiguous) return null;

    let total = 0;
    let current = 0;
    let largestScale = 0;
    for (const entry of entries) {
      if (entry.connector) continue;
      if (entry.scale !== undefined) {
        if (entry.scale >= 1_000) {
          if (total > 0 && entry.scale > largestScale) {
            total = (total + current) * entry.scale;
          } else {
            total += (current === 0 ? 1 : current) * entry.scale;
          }
          largestScale = Math.max(largestScale, entry.scale);
          current = 0;
        } else {
          current = (current === 0 ? 1 : current) * entry.scale;
        }
      } else if (entry.value !== undefined) {
        current += entry.value;
      }
    }
    return String(total + current);
  }
}
