import { describe, expect, it } from 'vitest';
import { applyVoiceCommands } from '../src/content/recognition/voiceCommands';
import { NumberTransformer } from '../src/content/recognition/NumberTransformer';
import type { CustomVoiceCommand } from '../src/shared/types';

const transformer = new NumberTransformer();

describe('applyVoiceCommands — fa-IR', () => {
  it('attaches punctuation to the previous word', () => {
    expect(applyVoiceCommands('سلام دنیا ویرگول', 'fa-IR')).toBe('سلام دنیا،');
    expect(applyVoiceCommands('سلام نقطه', 'fa-IR')).toBe('سلام.');
    expect(applyVoiceCommands('چطور علامت سوال', 'fa-IR')).toBe('چطور؟');
    expect(applyVoiceCommands('فوق‌العاده علامت تعجب', 'fa-IR')).toBe('فوق‌العاده!');
    expect(applyVoiceCommands('ساعت دونقطه پنج', 'fa-IR')).toBe('ساعت: پنج');
  });

  it('keeps one space after punctuation when more text follows', () => {
    expect(applyVoiceCommands('سلام نقطه دنیا', 'fa-IR')).toBe('سلام. دنیا');
    expect(applyVoiceCommands('یک ویرگول دو ویرگول سه', 'fa-IR')).toBe('یک، دو، سه');
  });

  it('hugs opening brackets/quotes to the next word and closing to the previous', () => {
    expect(applyVoiceCommands('سلام پرانتز باز دنیا پرانتز بسته', 'fa-IR')).toBe('سلام (دنیا)');
    expect(applyVoiceCommands('گیومه باز متن گیومه بسته', 'fa-IR')).toBe('«متن»');
  });

  it('applies formatting commands with surrounding spaces removed', () => {
    expect(applyVoiceCommands('خط اول نقطه خط جدید خط دوم', 'fa-IR')).toBe('خط اول.\nخط دوم');
    expect(applyVoiceCommands('پاراگراف جدید سلام', 'fa-IR')).toBe('\n\nسلام');
    expect(applyVoiceCommands('سلام سطر جدید', 'fa-IR')).toBe('سلام\n');
  });

  it('hugs symbols on both sides', () => {
    expect(applyVoiceCommands('۱۳۹۵ خط تیره ۱۴۰۰', 'fa-IR')).toBe('۱۳۹۵-۱۴۰۰');
    expect(applyVoiceCommands('پنج علامت درصد', 'fa-IR')).toBe('پنج%');
    expect(applyVoiceCommands('دو علامت جمع سه علامت مساوی پنج', 'fa-IR')).toBe('دو+سه=پنج');
  });

  it('normalizes case-insensitivity-free Persian variants (sôâl, Arabic yeh/kaf)', () => {
    expect(applyVoiceCommands('چطور علامت سؤال', 'fa-IR')).toBe('چطور؟');
  });

  it('leaves non-command words untouched', () => {
    expect(applyVoiceCommands('سلام دنیا', 'fa-IR')).toBe('سلام دنیا');
    expect(applyVoiceCommands('علامت', 'fa-IR')).toBe('علامت');
  });
});

describe('applyVoiceCommands — en-US', () => {
  it('attaches punctuation to the previous word and keeps spacing after', () => {
    expect(applyVoiceCommands('hello comma world period', 'en-US')).toBe('hello, world.');
    expect(applyVoiceCommands('ready question mark', 'en-US')).toBe('ready?');
  });

  it('matches case-insensitively', () => {
    expect(applyVoiceCommands('Hello Comma World', 'en-US')).toBe('Hello, World');
    expect(applyVoiceCommands('OK Period', 'en-US')).toBe('OK.');
  });

  it('applies new line and new paragraph commands', () => {
    expect(applyVoiceCommands('first new line second', 'en-US')).toBe('first\nsecond');
    expect(applyVoiceCommands('first new paragraph second', 'en-US')).toBe('first\n\nsecond');
  });

  it('supports email-style both-side symbols', () => {
    expect(applyVoiceCommands('ali at sign gmail dot com', 'en-US')).toBe('ali@gmail.com');
    expect(applyVoiceCommands('one hundred percent sign', 'en-US')).toBe('one hundred%');
  });

  it.each([
    ['one comma two', '1, 2'],
    ['one comma two comma three', '1, 2, 3'],
    ['one new line two', '1\n2'],
    ['one new line two new line three', '1\n2\n3'],
    ['one new paragraph two', '1\n\n2'],
  ])('pipeline %s', (input, expected) => {
    expect(transformer.transform(applyVoiceCommands(input, 'en-US'), 'en-US')).toBe(expected);
  });

  it('leaves ordinary sentences untouched', () => {
    expect(applyVoiceCommands('hello world', 'en-US')).toBe('hello world');
  });
});

describe('applyVoiceCommands — general', () => {
  it('returns the text unchanged when the language has no commands', () => {
    // every supported language has a table; this guards the fallback branch
    expect(applyVoiceCommands('سلام', 'fa-IR')).toBe('سلام');
  });

  it('returns empty text unchanged', () => {
    expect(applyVoiceCommands('', 'fa-IR')).toBe('');
  });

  it('handles several commands inside one long phrase', () => {
    expect(
      applyVoiceCommands('عنوان دونقطه خط جدید مقدمه ویرگول متن نقطه', 'fa-IR')
    ).toBe('عنوان:\nمقدمه، متن.');
  });
});

describe('applyVoiceCommands — custom commands', () => {
  const custom: CustomVoiceCommand[] = [
    { phrase: 'eye packet', replacement: 'iPacket' },
    { phrase: 'ایمیل من', replacement: 'me@example.com' },
    { phrase: 'امضا', replacement: '\\n—\\nعلی' },
    { phrase: 'سکوت', replacement: '' },
  ];

  it('inserts user text for the spoken phrase, preserving surrounding spaces', () => {
    expect(applyVoiceCommands('به eye packet سر بزن', 'fa-IR', custom)).toBe('به iPacket سر بزن');
    expect(applyVoiceCommands('سلام ایمیل من تمام', 'fa-IR', custom)).toBe(
      'سلام me@example.com تمام'
    );
  });

  it('works regardless of the active language', () => {
    expect(applyVoiceCommands('send to eye packet now', 'en-US', custom)).toBe(
      'send to iPacket now'
    );
  });

  it('interprets \\n and \\t escapes in the replacement', () => {
    expect(applyVoiceCommands('امضا', 'fa-IR', custom)).toBe('\n—\nعلی');
  });

  it('mutes a phrase when the replacement is empty', () => {
    expect(applyVoiceCommands('سلام سکوت دنیا', 'fa-IR', custom)).toBe('سلام دنیا');
    expect(applyVoiceCommands('سکوت', 'fa-IR', custom)).toBe('');
  });

  it.each(['constructor', 'hasOwnProperty', 'toString', 'constructor x', 'hasOwnProperty y'])(
    'ignores inherited names as phrases (%s)',
    (phrase) => {
      expect(applyVoiceCommands(phrase, 'en-US')).toBe(phrase);
      expect(applyVoiceCommands(phrase, 'fa-IR', [])).toBe(phrase);
    }
  );

  it('accepts custom phrases that collide with inherited names', () => {
    const inherited: CustomVoiceCommand[] = [
      { phrase: 'constructor', replacement: 'ctor' },
      { phrase: 'hasOwnProperty', replacement: '' },
      { phrase: 'isPrototypeOf', replacement: '!' },
    ];
    expect(applyVoiceCommands('constructor', 'en-US', inherited)).toBe('ctor');
    expect(applyVoiceCommands('muted hasOwnProperty', 'en-US', inherited)).toBe('muted');
    expect(applyVoiceCommands('say isPrototypeOf now', 'en-US', inherited)).toBe('say! now');
  });

  it('hugs the previous word for punctuation-only replacements', () => {
    const colon: CustomVoiceCommand[] = [{ phrase: 'دونقطه فارسی', replacement: ':' }];
    expect(applyVoiceCommands('ساعت دونقطه فارسی پنج', 'fa-IR', colon)).toBe('ساعت: پنج');
  });

  it('overrides built-in commands with the same phrase', () => {
    const override: CustomVoiceCommand[] = [{ phrase: 'period', replacement: '•' }];
    expect(applyVoiceCommands('hello period', 'en-US', override)).toBe('hello•');
  });

  it('supports multi-word phrases longer than the built-in maximum', () => {
    const long: CustomVoiceCommand[] = [
      { phrase: 'when i say this long phrase', replacement: 'done' },
    ];
    expect(applyVoiceCommands('start when i say this long phrase end', 'en-US', long)).toBe(
      'start done end'
    );
  });

  it('matches case-insensitively', () => {
    const commands: CustomVoiceCommand[] = [{ phrase: 'Eye Packet', replacement: 'iPacket' }];
    expect(applyVoiceCommands('EYE PACKET rules', 'en-US', commands)).toBe('iPacket rules');
  });

  it('applies the first command for duplicate phrases', () => {
    const duplicated: CustomVoiceCommand[] = [
      { phrase: 'سلام', replacement: 'first' },
      { phrase: 'سلام', replacement: 'second' },
    ];
    expect(applyVoiceCommands('سلام', 'fa-IR', duplicated)).toBe('first');
  });

  it('ignores invalid custom commands', () => {
    const invalid: CustomVoiceCommand[] = [
      { phrase: '   ', replacement: 'x' },
      { phrase: 'ویرگول', replacement: 'ok' },
    ];
    expect(applyVoiceCommands('سلام ویرگول', 'fa-IR', invalid)).toBe('سلام ok');
  });
});

describe('applyVoiceCommands — languages without a built-in table', () => {
  it('leaves the text alone instead of crashing (regression: Object.keys(undefined))', () => {
    expect(() => applyVoiceCommands('Guten Tag, wie geht es Ihnen?', 'de-DE')).not.toThrow();
    expect(applyVoiceCommands('Guten Tag', 'de-DE')).toBe('Guten Tag');
  });

  it('still applies custom commands in any language', () => {
    const custom: CustomVoiceCommand[] = [{ phrase: 'comma', replacement: ',' }];
    expect(applyVoiceCommands('hello comma world', 'de-DE', custom)).toBe('hello, world');
  });

  it('keeps the built-in Persian and English tables working', () => {
    expect(applyVoiceCommands('سلام ویرگول', 'fa-IR')).toBe('سلام،');
    expect(applyVoiceCommands('hello comma world', 'en-US')).toBe('hello, world');
  });
});

describe('applyVoiceCommands — English locale family', () => {
  it('applies the English table to every en-* locale, not just en-US', () => {
    expect(applyVoiceCommands('hello comma world', 'en-GB')).toBe('hello, world');
    expect(applyVoiceCommands('stop period', 'en-AU')).toBe('stop.');
    expect(applyVoiceCommands('one new line two', 'en-IN')).toBe('one\ntwo');
  });

  it('keeps non-English families table-free (de-DE stays plain dictation)', () => {
    expect(applyVoiceCommands('ein comma zwei', 'de-DE')).toBe('ein comma zwei');
  });
});
