import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FormControlAdapter } from '../src/content/insertion/FormControlAdapter';
import { withWordBoundarySpace } from '../src/content/insertion/InputAdapter';
import type { InsertionTarget } from '../src/shared/types';

describe('withWordBoundarySpace', () => {
  it('separates a new session text from existing text with a space', () => {
    expect(withWordBoundarySpace('hello', 'world')).toBe(' world');
    expect(withWordBoundarySpace('سلام', 'دنیا')).toBe(' دنیا');
  });

  it('keeps verbatim insertion after whitespace, at the start, and for punctuation', () => {
    expect(withWordBoundarySpace('hello ', 'world')).toBe('world');
    expect(withWordBoundarySpace('', 'hello')).toBe('hello');
    expect(withWordBoundarySpace('hello', '،')).toBe('،');
    expect(withWordBoundarySpace('hello', '(')).toBe('(');
  });
});

let adapter: FormControlAdapter;
let inputListener: ReturnType<typeof vi.fn>;
let textareaListener: ReturnType<typeof vi.fn>;

function makeInput(type = 'text', value = ''): HTMLInputElement {
  const input = document.createElement('input');
  input.type = type;
  input.value = value;
  input.addEventListener('input', inputListener as unknown as EventListener);
  document.body.appendChild(input);
  return input;
}

function makeTextarea(value = ''): HTMLTextAreaElement {
  const area = document.createElement('textarea');
  area.value = value;
  area.addEventListener('input', textareaListener as unknown as EventListener);
  document.body.appendChild(area);
  return area;
}

function caretOf(form: HTMLInputElement | HTMLTextAreaElement): number {
  return form.selectionStart as number;
}

beforeEach(() => {
  adapter = new FormControlAdapter();
  inputListener = vi.fn();
  textareaListener = vi.fn();
  document.body.innerHTML = '';
});

describe('FormControlAdapter.canHandle', () => {
  it('accepts supported input types and rejects unsupported ones', () => {
    for (const type of ['text', 'search', 'email', 'url', 'tel']) {
      expect(adapter.canHandle(makeInput(type))).toBe(true);
    }
    expect(adapter.canHandle(makeInput('password'))).toBe(false);
    expect(adapter.canHandle(makeInput('checkbox'))).toBe(false);
    const disabled = makeInput('text', 'x');
    disabled.disabled = true;
    expect(adapter.canHandle(disabled)).toBe(false);
  });

  it('rejects password unless explicitly allowed', () => {
    const strict = new FormControlAdapter();
    const permissive = new FormControlAdapter({ allowPassword: true });
    const field = makeInput('password');
    expect(strict.canHandle(field)).toBe(false);
    expect(permissive.canHandle(field)).toBe(true);
  });
});

describe('FormControlAdapter.insertText — caret positions', () => {
  it('inserts at the beginning of an empty field', () => {
    const input = makeInput();
    const target = adapter.captureTarget(input) as InsertionTarget;
    expect(adapter.insertText(target, 'hello')).toEqual({ ok: true });
    expect(input.value).toBe('hello');
    expect(caretOf(input)).toBe(5);
  });

  it('trims the engine’s leading space when inserting at the very start', () => {
    const input = makeInput();
    const target = adapter.captureTarget(input) as InsertionTarget;
    // Chrome prefixes utterances with a space (seen in real fa-IR logs).
    adapter.insertText(target, ' سلام دنیا');
    expect(input.value).toBe('سلام دنیا');
    expect(caretOf(input)).toBe(9);
  });

  it('keeps the engine’s leading space when inserting after existing text', () => {
    const input = makeInput('text', 'Hello');
    input.setSelectionRange(5, 5);
    const target = adapter.captureTarget(input) as InsertionTarget;
    adapter.insertText(target, ' world');
    expect(input.value).toBe('Hello world');
  });

  it('inserts exactly at a middle caret without touching other text', () => {
    const input = makeInput('text', 'Hello world');
    input.setSelectionRange(9, 9); // Hello wor|ld — caret is placed BEFORE capture
    const target = adapter.captureTarget(input) as InsertionTarget;
    adapter.insertText(target, 'beautiful');
    expect(input.value).toBe('Hello worbeautifulld');
    expect(caretOf(input)).toBe(18);
  });

  it('inserts at the end and leaves the caret after the inserted text', () => {
    const input = makeInput('text', 'Hello ');
    input.setSelectionRange(input.value.length, input.value.length);
    const target = adapter.captureTarget(input) as InsertionTarget;
    adapter.insertText(target, 'world');
    expect(input.value).toBe('Hello world');
    expect(caretOf(input)).toBe(11);
  });

  it('replaces a selection and collapses the caret after the new text', () => {
    const input = makeInput('text', 'Hello world');
    input.setSelectionRange(6, 11); // select "world" BEFORE capture
    const target = adapter.captureTarget(input) as InsertionTarget;
    adapter.insertText(target, 'everyone');
    expect(input.value).toBe('Hello everyone');
    expect(caretOf(input)).toBe(14);
  });

  it('advances the stored target so the next phrase continues from there', () => {
    const input = makeInput('text', 'abc');
    input.setSelectionRange(3, 3);
    const target = adapter.captureTarget(input) as InsertionTarget;
    adapter.insertText(target, 'def');
    expect(target).toMatchObject({ start: 6, end: 6 });
    adapter.insertText(target, 'ghi');
    expect(input.value).toBe('abcdefghi');
  });
});

describe('FormControlAdapter.insertText — framework + events', () => {
  it('dispatches a bubbling input event', () => {
    const input = makeInput();
    const target = adapter.captureTarget(input) as InsertionTarget;
    adapter.insertText(target, 'hi');
    expect(inputListener).toHaveBeenCalledTimes(1);
    const event = inputListener.mock.calls[0][0] as Event;
    expect(event.bubbles).toBe(true);
  });

  it('sets the value through the prototype setter, bypassing framework trackers', () => {
    const input = makeInput('text', 'Hello world');
    input.setSelectionRange(6, 6); // caret is placed BEFORE capture
    const target = adapter.captureTarget(input) as InsertionTarget;
    // Simulate a framework value tracker that swallows direct assignment:
    const proto = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
    Object.defineProperty(input, 'value', {
      configurable: true,
      get: () => (proto?.get ? proto.get.call(input) : ''),
      set: () => {
        throw new Error('framework swallowed the write');
      },
    });
    const result = adapter.insertText(target, 'big ');
    expect(result.ok).toBe(true);
    expect(input.value).toBe('Hello big world');
  });
});

describe('FormControlAdapter.insertText — multiline + validation', () => {
  it('keeps newlines in a textarea', () => {
    const area = makeTextarea('line1\nline2');
    area.setSelectionRange(6, 6); // start of line2 — BEFORE capture
    const target = adapter.captureTarget(area) as InsertionTarget;
    adapter.insertText(target, 'X\nY');
    expect(area.value).toBe('line1\nX\nYline2');
    expect(textareaListener).toHaveBeenCalled();
  });

  it('flattens newlines in single-line inputs', () => {
    const input = makeInput('text', 'ab');
    input.setSelectionRange(1, 1);
    const target = adapter.captureTarget(input) as InsertionTarget;
    adapter.insertText(target, 'one\ntwo');
    expect(input.value).toBe('aone twob');
  });

  it('falls back to end-of-value for input types without a selection API', () => {
    const input = makeInput('email', 'user@example.com');
    const target = adapter.captureTarget(input) as InsertionTarget;
    expect(target).not.toBeNull();
    adapter.insertText(target, ' and more');
    expect(input.value.endsWith(' and more')).toBe(true);
  });

  it('refuses to insert when the element was removed from the document', () => {
    const input = makeInput('text', 'abc');
    const target = adapter.captureTarget(input) as InsertionTarget;
    input.remove();
    const result = adapter.insertText(target, 'x');
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/removed/);
  });
});

describe('FormControlAdapter — live preview', () => {
  it('writes the interim text at the caret and moves the caret after it', () => {
    const input = makeInput('text', 'Hello');
    input.setSelectionRange(5, 5);
    const target = adapter.captureTarget(input) as InsertionTarget;
    expect(adapter.previewText(target, ' wor')).toEqual({ ok: true });
    expect(input.value).toBe('Hello wor');
    expect(caretOf(input)).toBe(9);
  });

  it('replaces the previous preview instead of appending', () => {
    const input = makeInput('text', 'Hello');
    input.setSelectionRange(5, 5);
    const target = adapter.captureTarget(input) as InsertionTarget;
    adapter.previewText(target, ' wor');
    adapter.previewText(target, ' world');
    expect(input.value).toBe('Hello world');
    expect(inputListener).toHaveBeenCalledTimes(2);
  });

  it('replaces the preview with the final transcript on commit', () => {
    const input = makeInput('text', 'Hello');
    input.setSelectionRange(5, 5);
    const target = adapter.captureTarget(input) as InsertionTarget;
    adapter.previewText(target, ' wor');
    adapter.insertText(target, ' world!');
    expect(input.value).toBe('Hello world!');
    expect(caretOf(input)).toBe(12);
    expect(target).toMatchObject({ previewStart: null, previewEnd: null });
    // the next phrase continues after the committed text
    adapter.insertText(target, ' Again');
    expect(input.value).toBe('Hello world! Again');
  });

  it('trims the engine’s leading space when the preview starts a field', () => {
    const input = makeInput();
    const target = adapter.captureTarget(input) as InsertionTarget;
    adapter.previewText(target, ' hello');
    expect(input.value).toBe('hello');
  });

  it('follows the live caret when the field is focused', () => {
    const input = makeInput('text', 'Hello');
    input.focus();
    input.setSelectionRange(3, 3); // user repositioned after capture
    const target = { type: 'input', element: input, start: 5, end: 5 } as InsertionTarget;
    adapter.previewText(target, ' big');
    expect(input.value).toBe('Hel biglo');
  });

  it('anchors to the captured position when the field is not focused', () => {
    const input = makeInput('text', 'Hello');
    input.setSelectionRange(5, 5);
    const target = adapter.captureTarget(input) as InsertionTarget;
    input.blur();
    adapter.previewText(target, ' world');
    expect(input.value).toBe('Hello world');
  });

  it('keeps newlines in a textarea preview and flattens them in inputs', () => {
    const area = makeTextarea('line1');
    area.setSelectionRange(5, 5);
    const areaTarget = adapter.captureTarget(area) as InsertionTarget;
    adapter.previewText(areaTarget, ' a\nb');
    expect(area.value).toBe('line1 a\nb');

    const input = makeInput('text', 'ab');
    input.setSelectionRange(1, 1);
    const inputTarget = adapter.captureTarget(input) as InsertionTarget;
    adapter.previewText(inputTarget, 'x\ny');
    expect(input.value).toBe('ax yb');
  });

  it('refuses to preview when the element was removed', () => {
    const input = makeInput('text', 'abc');
    const target = adapter.captureTarget(input) as InsertionTarget;
    input.remove();
    expect(adapter.previewText(target, 'x').ok).toBe(false);
  });

  it('resetPreview keeps the previewed text but drops the tracking', () => {
    const input = makeInput('text', 'Hello');
    input.setSelectionRange(5, 5);
    const target = adapter.captureTarget(input) as InsertionTarget;
    adapter.previewText(target, ' wor');
    adapter.resetPreview(target);
    expect(input.value).toBe('Hello wor');
    expect(target).toMatchObject({ previewStart: null, previewEnd: null });
    // without preview tracking, commit inserts at the live caret again
    input.focus();
    input.setSelectionRange(9, 9);
    adapter.insertText(target, ' ld');
    expect(input.value).toBe('Hello wor ld');
  });
});