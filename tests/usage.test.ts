import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  dayKey,
  emptyLedger,
  formatRequests,
  formatTokens,
  hourKey,
  loadUsageLedger,
  readTokenUsage,
  recordUsage,
  resetUsageLedger,
  sanitizeLedger,
  summarizeUsage,
  type UsageLedger,
} from '../src/shared/usage';
import type { TokenUsage } from '../src/shared/types';

function stubStorage(initial: Record<string, unknown> = {}): { get: ReturnType<typeof vi.fn>; set: ReturnType<typeof vi.fn> } {
  const values = { ...initial };
  const get = vi.fn(async (key: string) => ({ [key]: values[key] }));
  const set = vi.fn(async (value: Record<string, unknown>) => Object.assign(values, value));
  vi.stubGlobal('chrome', { storage: { local: { get, set, remove: vi.fn(async () => {}) } } });
  return { get, set };
}

const COUNTS = {
  promptTokens: 123,
  completionTokens: 12,
  totalTokens: 135,
  cachedTokens: 4,
  thoughtTokens: 0,
  toolUseTokens: 0,
  audioTokens: 123,
  rawPromptTokens: 529,
};

function usage(overrides: Partial<TokenUsage> = {}): TokenUsage {
  return { ...COUNTS, ...overrides };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('readTokenUsage', () => {
  it('reads a bare camelCase counts object', () => {
    // Some responses report the counts in camelCase rather than Google's
    // snake_case; they must still land in the totals rather than be dropped.
    expect(readTokenUsage({ usage: COUNTS })).toEqual(COUNTS);
  });

  it("reads Google's Interactions usage", () => {
    const payload = {
      output_text: 'hello',
      usage: {
        total_input_tokens: 123,
        total_output_tokens: 12,
        total_tokens: 135,
        total_cached_tokens: 4,
        total_thought_tokens: 0,
        total_tool_use_tokens: 0,
        // Only part of the prompt is the recording; the rest is the request.
        input_tokens_by_modality: { audio: 100, text: 23 },
        raw_prompt_token: 529,
      },
    };
    expect(readTokenUsage(payload)).toEqual({ ...COUNTS, audioTokens: 100 });
  });

  it('reads the object-forwarded interaction.usage shape', () => {
    expect(readTokenUsage({ interaction: { usage: { total_tokens: 500, total_input_tokens: 400, total_output_tokens: 100 } } }))
      .toMatchObject({ totalTokens: 500, promptTokens: 400, completionTokens: 100 });
  });

  it('reads a generateContent usageMetadata shape', () => {
    expect(readTokenUsage({ usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5, totalTokenCount: 15 } }))
      .toMatchObject({ promptTokens: 10, completionTokens: 5, totalTokens: 15 });
  });

  it('returns null when nothing was reported', () => {
    // Never fabricate a zero: "unreported" and "free" are different claims.
    for (const payload of [null, undefined, 'x', 42, [], {}, { ok: true, text: 'hi' }, { usage: {} }]) {
      expect(readTokenUsage(payload)).toBeNull();
    }
  });

  it('returns null for an all-zero report rather than recording a free request', () => {
    // A response with no counts at all must not become a zero: recording
    // zeros would make the counters claim a cost that was never metered.
    expect(readTokenUsage({ usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 } })).toBeNull();
  });

  it('derives a missing total from input plus output', () => {
    expect(readTokenUsage({ usage: { promptTokens: 30, completionTokens: 7 } }))
      .toMatchObject({ totalTokens: 37 });
  });

  it('rejects junk counts instead of trusting them', () => {
    const parsed = readTokenUsage({
      usage: { total_tokens: -50, total_input_tokens: NaN, total_output_tokens: Infinity, total_cached_tokens: 'many' },
    });
    // Only the derivable parts survive, and the total is rebuilt from them.
    expect(parsed).toBeNull();
  });

  it('keeps a fractional count rather than losing it to a parse failure', () => {
    expect(readTokenUsage({ usage: { total_tokens: 12.7 } })).toMatchObject({ totalTokens: 13 });
  });
});

describe('usage buckets', () => {
  it('keys buckets by the local calendar day and clock hour', () => {
    // Lexicographic order must equal chronological order, since pruning and the
    // month filter both rely on plain string comparison.
    const when = new Date(2026, 8, 28, 14, 32); // 28 Sep 2026, 14:32 local
    expect(dayKey(when)).toBe('2026-09-28');
    expect(hourKey(when)).toBe('2026-09-28T14');
    expect(dayKey(new Date(2026, 0, 5, 0, 0))).toBe('2026-01-05');
    expect(dayKey(new Date(2026, 11, 31, 23, 59))).toBe('2026-12-31');
  });

  it('sorts keys chronologically as strings', () => {
    const keys = ['2026-09-28T14', '2026-09-28T9', '2026-10-01T00', '2026-01-05T00'];
    expect([...keys].sort()).toEqual(['2026-01-05T00', '2026-09-28T14', '2026-09-28T9', '2026-10-01T00']);
  });
});

describe('recordUsage', () => {
  it('folds a request into the day, hour, and all-time buckets at once', async () => {
    stubStorage();
    const at = new Date(2026, 8, 28, 14, 32).getTime();

    await recordUsage({ usage: COUNTS, model: 'gemini-3.5-transcribe', at });

    const ledger = await loadUsageLedger();
    expect(ledger.last).toEqual({ at, model: 'gemini-3.5-transcribe', usage: COUNTS });
    expect(ledger.days['2026-09-28']).toEqual({
      requests: 1,
      promptTokens: 123,
      completionTokens: 12,
      totalTokens: 135,
      audioTokens: 123,
    });
    expect(ledger.hours['2026-09-28T14']?.totalTokens).toBe(135);
    expect(ledger.allTime.totalTokens).toBe(135);
  });

  it('accumulates across requests', async () => {
    stubStorage();
    const at = new Date(2026, 8, 28, 9, 0).getTime();
    await recordUsage({ usage: COUNTS, model: 'm', at });
    await recordUsage({ usage: usage({ totalTokens: 200, promptTokens: 190, completionTokens: 10 }), model: 'm', at });

    const summary = summarizeUsage(await loadUsageLedger(), new Date(2026, 8, 28, 9, 30));
    expect(summary.today).toEqual({
      requests: 2,
      promptTokens: 313,
      completionTokens: 22,
      totalTokens: 335,
      audioTokens: 246,
    });
    // `last` is the most recent request only, not a sum.
    expect(summary.last?.usage.totalTokens).toBe(200);
  });

  it('ignores a request with no reported usage', async () => {
    stubStorage();
    await recordUsage({ usage: undefined, model: 'm' });
    await recordUsage({ usage: {}, model: 'm' });

    const ledger = await loadUsageLedger();
    expect(ledger.allTime.requests).toBe(0);
    expect(ledger.last).toBeNull();
  });

  it('never throws when storage is unavailable', async () => {
    vi.stubGlobal('chrome', {
      storage: {
        local: {
          get: vi.fn(async () => { throw new Error('context invalidated'); }),
          set: vi.fn(async () => { throw new Error('context invalidated'); }),
          remove: vi.fn(async () => {}),
        },
      },
    });
    // Accounting must never be the reason a transcription fails.
    await expect(recordUsage({ usage: COUNTS, model: 'm' })).resolves.toBeUndefined();
  });

  it('prunes old day buckets but keeps the all-time total correct', async () => {
    stubStorage();
    // 400 days is the retention window; write 420 distinct days plus a repeat.
    for (let day = 0; day < 420; day += 1) {
      const at = new Date(2025, 0, 1 + day, 12, 0).getTime();
      await recordUsage({ usage: usage({ totalTokens: 10 }), model: 'm', at });
    }
    const ledger = await loadUsageLedger();
    expect(Object.keys(ledger.days)).toHaveLength(400);
    expect(ledger.days['2025-01-01']).toBeUndefined();
    // 420 requests, none forgotten: the lifetime accumulator is separate.
    expect(ledger.allTime.requests).toBe(420);
    expect(ledger.allTime.totalTokens).toBe(4200);
  });

  it('prunes old hour buckets to the rolling window', async () => {
    stubStorage();
    // 100 consecutive hours from 28 Sep 00:00 local, so the newest is
    // 2 Oct 03:00 and the oldest (28 Sep 00:00) must be the one to go.
    for (let hour = 0; hour < 100; hour += 1) {
      const at = new Date(2026, 8, 28, 0, 0).getTime() + hour * 60 * 60 * 1000;
      await recordUsage({ usage: usage({ totalTokens: 3 }), model: 'm', at });
    }
    const ledger = await loadUsageLedger();
    expect(Object.keys(ledger.hours)).toHaveLength(72);
    expect(ledger.hours['2026-09-28T00']).toBeUndefined();
    expect(ledger.hours['2026-09-29T04']?.totalTokens).toBe(3); // hour 28
    expect(ledger.hours['2026-10-02T03']?.totalTokens).toBe(3); // hour 99
  });
});

describe('summarizeUsage', () => {
  function ledgerWith(entries: Array<[Date, Partial<TokenUsage>]>, allTime?: number): UsageLedger {
    const ledger = emptyLedger();
    for (const [when, tokens] of entries) {
      const record = usage(tokens);
      const day = dayKey(when);
      const hour = hourKey(when);
      for (const bucket of [ledger.allTime, ledger.days[day] ??= { requests: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0, audioTokens: 0 }, ledger.hours[hour] ??= { requests: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0, audioTokens: 0 }]) {
        bucket.requests += 1;
        bucket.promptTokens += record.promptTokens;
        bucket.completionTokens += record.completionTokens;
        bucket.totalTokens += record.totalTokens;
        bucket.audioTokens += record.audioTokens;
      }
    }
    if (allTime !== undefined) ledger.allTime.totalTokens = allTime;
    return ledger;
  }

  it('separates today from yesterday and the rest of the month', () => {
    const now = new Date(2026, 8, 28, 14, 0);
    const ledger = ledgerWith([
      [new Date(2026, 8, 28, 9, 0), { totalTokens: 100 }],   // today, 5h ago
      [new Date(2026, 8, 28, 13, 0), { totalTokens: 50 }],   // today, 1h ago
      [new Date(2026, 8, 27, 14, 0), { totalTokens: 200 }],  // yesterday, 24h ago
      [new Date(2026, 8, 20, 14, 0), { totalTokens: 300 }],  // earlier this month
      [new Date(2026, 7, 10, 14, 0), { totalTokens: 900 }],  // last month
    ]);

    const summary = summarizeUsage(ledger, now);
    expect(summary.today.totalTokens).toBe(150);
    expect(summary.today.requests).toBe(2);
    // The rolling 24h window reaches back exactly 24 clock hours, so the 09:00
    // request (5h old) and the 13:00 one count, and yesterday's does not.
    expect(summary.last24h.totalTokens).toBe(150);
    expect(summary.month.totalTokens).toBe(650); // today + yesterday + the 20th
    expect(summary.allTime.totalTokens).toBe(1550); // everything, incl. last month
  });

  it('counts a request made just after midnight as recent in the 24h window', () => {
    // 00:05 today is 23h55m old, so a naive "since yesterday" filter would drop it.
    const now = new Date(2026, 8, 28, 0, 5);
    const ledger = ledgerWith([[new Date(2026, 8, 28, 0, 0), { totalTokens: 42 }]]);
    const summary = summarizeUsage(ledger, now);
    expect(summary.today.totalTokens).toBe(42);
    expect(summary.last24h.totalTokens).toBe(42);
  });

  it('reports zeros for an untouched ledger instead of throwing', () => {
    const summary = summarizeUsage(emptyLedger(), new Date(2026, 8, 28, 14, 0));
    expect(summary.last).toBeNull();
    for (const period of [summary.today, summary.last24h, summary.month, summary.allTime]) {
      expect(period).toEqual({ requests: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0, audioTokens: 0 });
    }
  });

  it('starts a new month on the first and does not mix two months', () => {
    const now = new Date(2026, 8, 1, 0, 30); // 1 Sep, just after midnight
    const ledger = ledgerWith([
      [new Date(2026, 7, 31, 23, 0), { totalTokens: 500 }], // 31 Aug
      [new Date(2026, 8, 1, 0, 10), { totalTokens: 10 }],   // 1 Sep
    ]);
    const summary = summarizeUsage(ledger, now);
    expect(summary.today.totalTokens).toBe(10);
    expect(summary.month.totalTokens).toBe(10);
    expect(summary.allTime.totalTokens).toBe(510);
  });
});

describe('sanitizeLedger', () => {
  it('returns an empty ledger for junk', () => {
    for (const value of [undefined, null, 'x', 42, []]) {
      expect(sanitizeLedger(value)).toEqual(emptyLedger());
    }
  });

  it('keeps the readable parts of a partly corrupt ledger', () => {
    // A ledger that survived a schema change must not cost the user their
    // whole history: drop the unreadable keys, keep the rest.
    const sanitized = sanitizeLedger({
      version: 1,
      allTime: { requests: 3, totalTokens: 300, garbage: 'x' },
      days: { '2026-09-28': { requests: 1, totalTokens: 100 }, 'not-a-date': { requests: 9 } },
      hours: { '2026-09-28T14': { requests: 1, totalTokens: 100 }, '2026-13-99T99': { requests: 9 } },
      last: { at: 1, model: 'm', usage: COUNTS },
    });
    expect(sanitized.allTime).toEqual({ requests: 3, promptTokens: 0, completionTokens: 0, totalTokens: 300, audioTokens: 0 });
    expect(Object.keys(sanitized.days)).toEqual(['2026-09-28']);
    expect(Object.keys(sanitized.hours)).toEqual(['2026-09-28T14']);
    expect(sanitized.last?.usage.totalTokens).toBe(135);
  });

  it('drops a last record whose usage or timestamp is unusable', () => {
    expect(sanitizeLedger({ last: { at: 1, model: 'm' } }).last).toBeNull();
    expect(sanitizeLedger({ last: { model: 'm', usage: COUNTS } }).last).toBeNull();
    expect(sanitizeLedger({ last: { at: -5, model: 'm', usage: COUNTS } }).last).toBeNull();
  });

  it('rejects a negative count in a bucket rather than subtracting from a total', () => {
    const sanitized = sanitizeLedger({ days: { '2026-09-28': { requests: -5, totalTokens: -100 } } });
    expect(sanitized.days['2026-09-28']).toMatchObject({ requests: 0, totalTokens: 0 });
  });
});

describe('resetUsageLedger', () => {
  it('clears every counter and the last request', async () => {
    stubStorage();
    await recordUsage({ usage: COUNTS, model: 'm', at: new Date(2026, 8, 28, 14, 0).getTime() });
    await resetUsageLedger();

    const ledger = await loadUsageLedger();
    expect(ledger).toEqual(emptyLedger());
    expect(summarizeUsage(ledger).allTime.totalTokens).toBe(0);
  });
});

describe('formatting', () => {
  it('groups thousands so long counts stay readable', () => {
    expect(formatTokens(135)).toBe('135');
    expect(formatTokens(1234567)).toBe(
      (1234567).toLocaleString()
    );
  });

  it('never renders a negative count', () => {
    expect(formatTokens(-5)).toBe('0');
  });

  it('agrees in number with the count', () => {
    expect(formatRequests(1)).toBe('1 request');
    expect(formatRequests(0)).toBe('0 requests');
    expect(formatRequests(2)).toBe('2 requests');
  });
});
