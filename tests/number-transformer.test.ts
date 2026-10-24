import { describe, expect, it } from 'vitest';
import { NumberTransformer } from '../src/content/recognition/NumberTransformer';

const transformer = new NumberTransformer();

describe('NumberTransformer — en-US', () => {
  it('converts single words and hyphen-free compounds', () => {
    expect(transformer.transform('one', 'en-US')).toBe('1');
    expect(transformer.transform('twenty five', 'en-US')).toBe('25');
    expect(transformer.transform('one hundred twenty three', 'en-US')).toBe('123');
  });

  it('handles scale words and the and-connector', () => {
    expect(transformer.transform('two thousand and twenty six', 'en-US')).toBe('2026');
    expect(transformer.transform('one thousand', 'en-US')).toBe('1000');
    expect(transformer.transform('three million four hundred thousand', 'en-US')).toBe('3400000');
    expect(transformer.transform('one billion two hundred', 'en-US')).toBe('1000000200');
  });

  it('converts numbers inside mixed sentences', () => {
    expect(transformer.transform('I have twenty five files', 'en-US')).toBe('I have 25 files');
    // additive time-of-day compounds stay arithmetic: nine + thirty = 39
    expect(transformer.transform('meeting at nine thirty', 'en-US')).toBe('meeting at 39');
  });

  it('converts hyphenated compounds like twenty-five', () => {
    expect(transformer.transform('I am twenty-five years old', 'en-US')).toBe('I am 25 years old');
  });

  it.each([
    ['one hundred twenty-five', '125'],
    ['one hundred and twenty-five', '125'],
    ['one hundred and twenty-five thousand', '125000'],
    ['(one hundred and twenty-five), two', '(125), 2'],
    ['twenty-five, thirty-six', '25, 36'],
    ['twenty-five\nforty-two', '25\n42'],
    ['one hundred and twenty-five, six', '125, 6'],
  ])('converts hyphenated compounds within %s', (input, expected) => {
    expect(transformer.transform(input, 'en-US')).toBe(expected);
  });

  it.each([
    ['thousand million', '1000000000'],
    ['two thousand million', '2000000000'],
    ['two thousand three hundred million', '2300000000'],
    ['thousand million two thousand', '1000002000'],
    ['one million two hundred thousand three hundred', '1200300'],
  ])('handles scale ordering in %s', (input, expected) => {
    expect(transformer.transform(input, 'en-US')).toBe(expected);
  });

  it('keeps the and-connector when it is a conjunction, not a number part', () => {
    expect(transformer.transform('between five and six', 'en-US')).toBe('between 5 and 6');
    expect(transformer.transform('cats and dogs', 'en-US')).toBe('cats and dogs');
  });

  it('never touches existing digits or identifiers', () => {
    expect(transformer.transform('I have 25 files', 'en-US')).toBe('I have 25 files');
    expect(transformer.transform('version 3.5 works', 'en-US')).toBe('version 3.5 works');
    expect(transformer.transform('call 217-652-8632', 'en-US')).toBe('call 217-652-8632');
    expect(transformer.transform('date 2026/05/01', 'en-US')).toBe('date 2026/05/01');
    expect(transformer.transform('ID 45 and 456', 'en-US')).toBe('ID 45 and 456');
    expect(transformer.transform('room 7b', 'en-US')).toBe('room 7b');
  });

  it('leaves ordinary words untouched', () => {
    expect(transformer.transform('hello world', 'en-US')).toBe('hello world');
    expect(transformer.transform('', 'en-US')).toBe('');
  });
});

describe('NumberTransformer — fa-IR', () => {
  it('converts single words and compound numbers with و', () => {
    expect(transformer.transform('یک', 'fa-IR')).toBe('1');
    expect(transformer.transform('بیست و پنج', 'fa-IR')).toBe('25');
    expect(transformer.transform('صد و بیست و سه', 'fa-IR')).toBe('123');
    expect(transformer.transform('دو هزار و بیست و شش', 'fa-IR')).toBe('2026');
  });

  it('handles hundreds-thousands compounds', () => {
    expect(transformer.transform('یک هزار', 'fa-IR')).toBe('1000');
    expect(transformer.transform('دو میلیون', 'fa-IR')).toBe('2000000');
    expect(transformer.transform('سه میلیارد و دویست میلیون', 'fa-IR')).toBe('3200000000');
    expect(transformer.transform('نهصد و نود و نه', 'fa-IR')).toBe('999');
  });

  it.each([
    ['هزار میلیارد', '1000000000000'],
    ['دو هزار میلیارد', '2000000000000'],
    ['هزار میلیارد و دویست میلیون', '1000200000000'],
  ])('handles ascending scales in %s', (input, expected) => {
    expect(transformer.transform(input, 'fa-IR')).toBe(expected);
  });

  it('converts numbers inside mixed Persian sentences', () => {
    expect(transformer.transform('من بیست و پنج فایل دارم', 'fa-IR')).toBe('من 25 فایل دارم');
    expect(transformer.transform('قیمت پنج هزار تومان شد', 'fa-IR')).toBe('قیمت 5000 تومان شد');
  });

  it('keeps the و connector when it is a conjunction, not a number part', () => {
    expect(transformer.transform('بین پنج و شش', 'fa-IR')).toBe('بین 5 و 6');
    expect(transformer.transform('ساعت پنج و سی', 'fa-IR')).toBe('ساعت 5 و 30');
    expect(transformer.transform('چای و شکر', 'fa-IR')).toBe('چای و شکر');
  });

  it('keeps standalone نه as the word "no" but converts it inside numbers', () => {
    expect(transformer.transform('نه، ممنون', 'fa-IR')).toBe('نه، ممنون');
    expect(transformer.transform('نود و نه', 'fa-IR')).toBe('99');
  });

  it('never touches existing digits — Latin or Persian — or identifiers', () => {
    expect(transformer.transform('من 25 فایل دارم', 'fa-IR')).toBe('من 25 فایل دارم');
    expect(transformer.transform('من ۲۵ فایل دارم', 'fa-IR')).toBe('من ۲۵ فایل دارم');
    expect(transformer.transform('شماره ۰۹۱۲ ۳۴۵ ۶۷۸۹', 'fa-IR')).toBe('شماره ۰۹۱۲ ۳۴۵ ۶۷۸۹');
    expect(transformer.transform('نسخه ۳.۵ خوب است', 'fa-IR')).toBe('نسخه ۳.۵ خوب است');
    expect(transformer.transform('شناسه ۴۵۶', 'fa-IR')).toBe('شناسه ۴۵۶');
  });

  it('normalizes ZWNJ and Arabic yeh/kaf variants', () => {
    // «يكصد» written with Arabic ي + ك matches یکصد (100); «چهار‌صد» with a
    // ZWNJ inside matches چهارصد (400).
    expect(transformer.transform('يكصد و پنجاه', 'fa-IR')).toBe('150');
    expect(transformer.transform('چهار\u200cصد', 'fa-IR')).toBe('400');
  });

  it('leaves ordinary Persian words untouched', () => {
    expect(transformer.transform('سلام دنیا', 'fa-IR')).toBe('سلام دنیا');
    expect(transformer.transform('', 'fa-IR')).toBe('');
  });
});

describe('NumberTransformer — general', () => {
  it.each([
    ['one, two', 'en-US', '1, 2'],
    ['یک، دو', 'fa-IR', '1، 2'],
    ['one\ntwo', 'en-US', '1\n2'],
    ['یک\nدو', 'fa-IR', '1\n2'],
    ['twenty\r\nfive', 'en-US', '20\r\n5'],
    ['twenty\n\nfive', 'en-US', '20\n\n5'],
    ['twenty\u2028five', 'en-US', '20\u20285'],
    ['twenty\u2029five', 'en-US', '20\u20295'],
    ['one (two)', 'en-US', '1 (2)'],
    ['(twenty five) six', 'en-US', '(25) 6'],
    ['twenty and\nfive', 'en-US', '20 and\n5'],
    ['twenty and (five)', 'en-US', '20 and (5)'],
    ['twenty and, five', 'en-US', '20 and, 5'],
    ['بیست و\nپنج', 'fa-IR', '20 و\n5'],
    ['one; two! three?', 'en-US', '1; 2! 3?'],
    ['twenty\t five', 'en-US', '25'],
  ] as const)('preserves number boundaries in %s', (input, language, expected) => {
    expect(transformer.transform(input, language)).toBe(expected);
    expect(transformer.transform(expected, language)).toBe(expected);
  });

  it.each(['en-US', 'fa-IR'] as const)('ignores inherited word lookups in %s', (language) => {
    expect(transformer.transform('constructor', language)).toBe('constructor');
    expect(transformer.transform('constructor prototype toString hasOwnProperty', language)).toBe(
      'constructor prototype toString hasOwnProperty'
    );
  });

  it('does not accept inherited entries in hyphenated words or connector lookahead', () => {
    expect(transformer.transform('twenty-constructor', 'en-US')).toBe('twenty-constructor');
    expect(transformer.transform('one hundred and constructor', 'en-US')).toBe('100 and constructor');
  });

  it('is idempotent — converting twice changes nothing further', () => {
    const once = transformer.transform('twenty five files', 'en-US');
    expect(transformer.transform(once, 'en-US')).toBe(once);
  });

  it('converts several numbers in one sentence', () => {
    expect(transformer.transform('buy two apples and ten oranges', 'en-US')).toBe(
      'buy 2 apples and 10 oranges'
    );
    expect(transformer.transform('دو سیب و ده پرتقال', 'fa-IR')).toBe('2 سیب و 10 پرتقال');
  });
});

describe('NumberTransformer — English locale family', () => {
  it('converts numbers for every en-* locale, including hyphenated compounds', () => {
    expect(transformer.transform('twenty five', 'en-GB')).toBe('25');
    expect(transformer.transform('twenty-five', 'en-GB')).toBe('25');
    expect(transformer.transform('one hundred twenty three', 'en-AU')).toBe('123');
  });

  it('leaves other families untouched', () => {
    expect(transformer.transform('eins zwei', 'de-DE')).toBe('eins zwei');
  });
});
