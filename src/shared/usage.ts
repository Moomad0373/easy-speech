/**
 * Token accounting for the Voice Transcribing engine.
 *
 * Google reports what each transcription cost. This module turns that report
 * into two things:
 *
 *   1. `readTokenUsage` — a validated `TokenUsage` out of whichever response
 *      shape arrived, or null when nothing was reported. It never invents
 *      zeros: a request with no reported usage stays uncounted rather than
 *      being recorded as free.
 *   2. `recordUsage` — a bounded, local ledger of daily and hourly buckets,
 *      which is what the Settings page aggregates into last-request / today /
 *      last-24-hours / this-month / all-time totals.
 *
 * Buckets are keyed by the user's LOCAL calendar day and clock hour, so "today"
 * means their today and the "last 24 hours" figure is a rolling window rather
 * than a midnight-to-midnight one. Nothing here ever leaves the browser: the
 * ledger lives in chrome.storage.local and holds counts only, never the audio,
 * the transcript, or the custom vocabulary.
 */
import type { TokenUsage } from './types';

/** Local-only counters. No audio, no text, no settings — counts and a clock. */
const USAGE_KEY = 'tokenUsage';

/**
 * Days of history to keep. The all-time total is a separate running
 * accumulator that is never pruned, so dropping old days only limits how far
 * back "this month" can reach — it never makes the lifetime figure wrong.
 */
const MAX_DAY_BUCKETS = 400;

/**
 * Hours of history to keep for the rolling 24-hour figure. 72 gives a full
 * day of slack so a laptop that was asleep still has the hours it missed.
 */
const MAX_HOUR_BUCKETS = 72;

/** A non-negative whole number, or null. Rejects NaN, Infinity, floats, junk. */
function count(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  if (value < 0) return null;
  return Math.round(value);
}

function firstCount(...values: unknown[]): number {
  for (const value of values) {
    const parsed = count(value);
    if (parsed !== null) return parsed;
  }
  return 0;
}

/**
 * Google's per-modality breakdown, e.g. `input_tokens_by_modality: { audio: N }`.
 * The audio share is what makes a transcription bill legible: it is the part of
 * the prompt that is the recording rather than the request.
 */
function audioModalityTokens(value: unknown): number {
  if (typeof value !== 'object' || value === null) return 0;
  return firstCount((value as Record<string, unknown>).audio);
}

/**
 * Every field name each source uses for the same number. Several vocabularies
 * have to be understood, because Google's own surfaces do not agree:
 *
 *   - the Interactions API, snake_case (`total_input_tokens`) and nested
 *     per-modality (`input_tokens_by_modality.audio`) — the live path;
 *   - `usageMetadata` from generateContent (`promptTokenCount`) — the older
 *     shape, still accepted for models pointed at by mistake;
 *   - bare camelCase (`promptTokens`), kept so a response that uses it is still
 *     counted rather than silently dropped from the totals.
 */
const FIELD_ALIASES = {
  promptTokens: ['promptTokens', 'prompt_tokens', 'total_input_tokens', 'promptTokenCount'],
  completionTokens: ['completionTokens', 'completion_tokens', 'total_output_tokens', 'candidatesTokenCount'],
  totalTokens: ['totalTokens', 'total_tokens', 'totalTokenCount'],
  cachedTokens: ['cachedTokens', 'cached_tokens', 'total_cached_tokens', 'cachedContentTokenCount'],
  thoughtTokens: ['thoughtTokens', 'thought_tokens', 'total_thought_tokens', 'thoughtsTokenCount'],
  toolUseTokens: ['toolUseTokens', 'tool_use_tokens', 'total_tool_use_tokens', 'toolUsePromptTokenCount'],
  audioTokens: ['audioTokens', 'audio_tokens'],
  rawPromptTokens: ['rawPromptTokens', 'raw_prompt_tokens', 'raw_prompt_token'],
} as const satisfies Record<keyof TokenUsage, readonly string[]>;

/**
 * Normalizes a TokenUsage-shaped object from any of the three vocabularies.
 */
function usageFromRecord(raw: Record<string, unknown>): TokenUsage | null {
  const pick = (field: keyof TokenUsage): number =>
    firstCount(...FIELD_ALIASES[field].map((alias) => raw[alias]));

  const usage: TokenUsage = {
    promptTokens: pick('promptTokens'),
    completionTokens: pick('completionTokens'),
    totalTokens: pick('totalTokens'),
    cachedTokens: pick('cachedTokens'),
    thoughtTokens: pick('thoughtTokens'),
    toolUseTokens: pick('toolUseTokens'),
    audioTokens: firstCount(
      ...FIELD_ALIASES.audioTokens.map((alias) => raw[alias]),
      audioModalityTokens(raw.input_tokens_by_modality)
    ),
    rawPromptTokens: pick('rawPromptTokens'),
  };

  // A total is what every aggregate is built on, so derive it when the source
  // did not report one. If nothing at all was reported, this is not usage.
  if (usage.totalTokens === 0) usage.totalTokens = usage.promptTokens + usage.completionTokens;
  const reported = Object.values(usage).reduce((sum, value) => sum + value, 0);
  return reported > 0 ? usage : null;
}

/**
 * Reads token usage out of any response the extension can receive. The shapes
 * are accepted in the order they are tried:
 *
 *   1. `usage` at the root          `{ usage: { total_input_tokens, … } }` —
 *                                   Google's Interactions API, the live path
 *   2. `interaction.usage`          the object-forwarded equivalent
 *   3. `usageMetadata`              the generateContent shape
 *   4. the root object itself       a bare, unwrapped counts object
 *
 * Returns null when no counts were reported, so the caller can distinguish
 * "free" from "unreported" instead of recording a misleading zero.
 */
export function readTokenUsage(payload: unknown): TokenUsage | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const root = payload as Record<string, unknown>;

  const candidates: unknown[] = [
    root.usage,
    (root.interaction as { usage?: unknown } | undefined)?.usage,
    root.usageMetadata,
  ];
  for (const candidate of candidates) {
    if (typeof candidate !== 'object' || candidate === null) continue;
    const usage = usageFromRecord(candidate as Record<string, unknown>);
    if (usage) return usage;
  }
  return null;
}

/** Aggregate figures for one period. `requests` counts every billed request. */
export interface UsageTotals {
  requests: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  audioTokens: number;
}

/** The last request in full detail, kept verbatim for the breakdown view. */
export interface UsageRecord {
  at: number;
  model: string;
  usage: TokenUsage;
}

interface Bucket {
  requests: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  audioTokens: number;
}

export interface UsageLedger {
  version: 1;
  last: UsageRecord | null;
  /** Running lifetime totals. Never pruned, so old days can be dropped safely. */
  allTime: Bucket;
  /** Keyed by local calendar day, `YYYY-MM-DD`. */
  days: Record<string, Bucket>;
  /** Keyed by local clock hour, `YYYY-MM-DDTHH`. */
  hours: Record<string, Bucket>;
}

function emptyBucket(): Bucket {
  return { requests: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0, audioTokens: 0 };
}

/** Local calendar day, e.g. `2026-09-28`. Lexicographic order == time order. */
export function dayKey(date: Date): string {
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${date.getFullYear()}-${month}-${day}`;
}

/** Local clock hour, e.g. `2026-09-28T14`. */
export function hourKey(date: Date): string {
  return `${dayKey(date)}T${String(date.getHours()).padStart(2, '0')}`;
}

function addTo(bucket: Bucket, usage: TokenUsage): void {
  bucket.requests += 1;
  bucket.promptTokens += usage.promptTokens;
  bucket.completionTokens += usage.completionTokens;
  bucket.totalTokens += usage.totalTokens;
  bucket.audioTokens += usage.audioTokens;
}

function sumBuckets(buckets: Bucket[]): UsageTotals {
  return buckets.reduce<UsageTotals>(
    (total, bucket) => ({
      requests: total.requests + bucket.requests,
      promptTokens: total.promptTokens + bucket.promptTokens,
      completionTokens: total.completionTokens + bucket.completionTokens,
      totalTokens: total.totalTokens + bucket.totalTokens,
      audioTokens: total.audioTokens + bucket.audioTokens,
    }),
    { requests: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0, audioTokens: 0 }
  );
}

/** Repairs a bucket read out of storage; anything unusable becomes zeros. */
function sanitizeBucket(value: unknown): Bucket {
  const bucket = emptyBucket();
  if (typeof value !== 'object' || value === null) return bucket;
  const raw = value as Record<string, unknown>;
  bucket.requests = firstCount(raw.requests);
  bucket.promptTokens = firstCount(raw.promptTokens);
  bucket.completionTokens = firstCount(raw.completionTokens);
  bucket.totalTokens = firstCount(raw.totalTokens);
  bucket.audioTokens = firstCount(raw.audioTokens);
  return bucket;
}

/**
 * A bucket key is machine-generated, so anything outside the real ranges is
 * corrupt rather than merely unusual: there is no 13th month, no 99th day, and
 * no 99th hour. Range-checking keeps junk keys out of the maps, which the
 * month filter and the string-order pruning would otherwise trust.
 */
function isBucketKey(key: string, withHour: boolean): boolean {
  const match = withHour
    ? /^(\d{4})-(\d{2})-(\d{2})T(\d{2})$/.exec(key)
    : /^(\d{4})-(\d{2})-(\d{2})$/.exec(key);
  if (!match) return false;
  const [, year, month, day, hour] = match;
  if (year === '0000') return false;
  const monthNumber = Number(month);
  const dayNumber = Number(day);
  if (monthNumber < 1 || monthNumber > 12) return false;
  if (dayNumber < 1 || dayNumber > 31) return false;
  if (hour !== undefined) {
    const hourNumber = Number(hour);
    if (hourNumber > 23) return false;
  }
  return true;
}

function sanitizeBucketMap(value: unknown, withHour: boolean): Record<string, Bucket> {
  const result: Record<string, Bucket> = {};
  if (typeof value !== 'object' || value === null) return result;
  for (const [key, bucket] of Object.entries(value as Record<string, unknown>)) {
    if (isBucketKey(key, withHour)) result[key] = sanitizeBucket(bucket);
  }
  return result;
}

function sanitizeUsage(value: unknown): TokenUsage | null {
  if (typeof value !== 'object' || value === null) return null;
  return usageFromRecord(value as Record<string, unknown>);
}

export function emptyLedger(): UsageLedger {
  return { version: 1, last: null, allTime: emptyBucket(), days: {}, hours: {} };
}

/**
 * Rebuilds a ledger from storage, discarding anything that does not fit the
 * current shape. A partially corrupt ledger degrades to the parts that are
 * readable rather than throwing away the user's whole history.
 */
export function sanitizeLedger(value: unknown): UsageLedger {
  if (typeof value !== 'object' || value === null) return emptyLedger();
  const raw = value as Record<string, unknown>;
  const ledger = emptyLedger();
  ledger.allTime = sanitizeBucket(raw.allTime);
  ledger.days = sanitizeBucketMap(raw.days, false);
  ledger.hours = sanitizeBucketMap(raw.hours, true);
  if (typeof raw.last === 'object' && raw.last !== null) {
    const last = raw.last as Record<string, unknown>;
    const usage = sanitizeUsage(last.usage);
    const at = count(last.at);
    if (usage && at !== null) {
      ledger.last = {
        at,
        model: typeof last.model === 'string' ? last.model : '',
        usage,
      };
    }
  }
  return ledger;
}

/** Drops the oldest keys past the retention window. Keys sort as strings. */
function prune(map: Record<string, Bucket>, keep: number): Record<string, Bucket> {
  const keys = Object.keys(map).sort();
  if (keys.length <= keep) return map;
  const result: Record<string, Bucket> = {};
  for (const key of keys.slice(keys.length - keep)) result[key] = map[key]!;
  return result;
}

/** Loads the ledger. Never throws — an unreadable store yields an empty one. */
export async function loadUsageLedger(): Promise<UsageLedger> {
  try {
    const stored = await chrome.storage.local.get(USAGE_KEY);
    return sanitizeLedger(stored[USAGE_KEY]);
  } catch {
    return emptyLedger();
  }
}

export async function saveUsageLedger(ledger: UsageLedger): Promise<void> {
  try {
    await chrome.storage.local.set({ [USAGE_KEY]: ledger });
  } catch {
    // Storage unavailable (e.g. context invalidated) — counters are not critical.
  }
}

/** Clears every counter. Used by the Settings page's "Reset counters" action. */
export async function resetUsageLedger(): Promise<void> {
  await saveUsageLedger(emptyLedger());
}

/**
 * Folds one request's usage into the ledger. Call this even for a FAILED
 * request: a request that returned no transcript still consumed quota, and
 * hiding that would make the counters disagree with the bill.
 *
 * Never throws, and never records a request with no reported usage.
 */
export async function recordUsage(input: { usage: unknown; model: string; at?: number }): Promise<void> {
  const usage = sanitizeUsage(input.usage);
  if (!usage) return;
  try {
    const ledger = await loadUsageLedger();
    const at = typeof input.at === 'number' && Number.isFinite(input.at) ? input.at : Date.now();
    const when = new Date(at);

    addTo(ledger.allTime, usage);
    const day = dayKey(when);
    ledger.days[day] = addToBucket(ledger.days[day], usage);
    const hour = hourKey(when);
    ledger.hours[hour] = addToBucket(ledger.hours[hour], usage);
    ledger.days = prune(ledger.days, MAX_DAY_BUCKETS);
    ledger.hours = prune(ledger.hours, MAX_HOUR_BUCKETS);
    ledger.last = { at, model: input.model, usage };

    await saveUsageLedger(ledger);
  } catch {
    // Never let accounting break a transcription.
  }
}

function addToBucket(existing: Bucket | undefined, usage: TokenUsage): Bucket {
  const bucket = existing ? { ...existing } : emptyBucket();
  addTo(bucket, usage);
  return bucket;
}

export interface UsageSummary {
  last: UsageRecord | null;
  today: UsageTotals;
  last24h: UsageTotals;
  month: UsageTotals;
  allTime: UsageTotals;
}

/**
 * Aggregates the ledger into the periods the Settings page shows.
 *
 * `today` is the user's local calendar day. `last24h` is a true rolling 24
 * hours: the bucket a request lands in is the clock hour it arrived in, so the
 * hour at exactly 24 hours ago is excluded — everything in it is at least 24
 * hours old — while the current, partly-elapsed hour is included, so a request
 * made a minute ago is never lost. `month` is the current local calendar month.
 */
export function summarizeUsage(ledger: UsageLedger, now: Date = new Date()): UsageSummary {
  const todayKey = dayKey(now);
  const currentHour = hourKey(now);
  const hourFloor = hourKey(new Date(now.getTime() - 24 * 60 * 60 * 1000));
  const monthPrefix = todayKey.slice(0, 7);

  return {
    last: ledger.last,
    today: sumBuckets(ledger.days[todayKey] ? [ledger.days[todayKey]!] : []),
    last24h: sumBuckets(
      Object.keys(ledger.hours)
        .filter((key) => key > hourFloor && key <= currentHour)
        .map((key) => ledger.hours[key]!)
    ),
    month: sumBuckets(
      Object.keys(ledger.days)
        .filter((key) => key.startsWith(monthPrefix))
        .map((key) => ledger.days[key]!)
    ),
    allTime: sumBuckets([ledger.allTime]),
  };
}

/** `1234567` → `1,234,567`; negative and junk input never reaches this. */
export function formatTokens(value: number): string {
  return Math.max(0, Math.round(value)).toLocaleString();
}

/** `1` → `1 request`, `3` → `3 requests`. */
export function formatRequests(value: number): string {
  return `${formatTokens(value)} ${value === 1 ? 'request' : 'requests'}`;
}

/** "Today at 14:32" / "28 Sep at 09:05" — whichever is closer and unambiguous. */
export function formatUsageTime(at: number, now: Date = new Date()): string {
  const when = new Date(at);
  if (Number.isNaN(when.getTime())) return '';
  const time = when.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  if (dayKey(when) === dayKey(now)) return `Today at ${time}`;
  if (dayKey(when) === dayKey(new Date(now.getTime() - 24 * 60 * 60 * 1000))) {
    return `Yesterday at ${time}`;
  }
  return `${when.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })} at ${time}`;
}
