import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TargetManager } from '../src/content/insertion/TargetManager';
import { FormControlAdapter } from '../src/content/insertion/FormControlAdapter';
import { ContentEditableAdapter } from '../src/content/insertion/ContentEditableAdapter';
import { GoogleKeepAdapter } from '../src/content/insertion/GoogleKeepAdapter';
import { buildSelector } from '../src/content/insertion/TargetManager';
import type { InsertionTarget } from '../src/shared/types';

let manager: TargetManager;

function stubSelection(range: Range | null): void {
  const selection = {
    rangeCount: range ? 1 : 0,
    getRangeAt: () => range,
    removeAllRanges: vi.fn(),
    addRange: vi.fn(),
  };
  vi.spyOn(window, 'getSelection').mockReturnValue(selection as unknown as Selection);
}

beforeEach(() => {
  manager = new TargetManager([new FormControlAdapter(), new ContentEditableAdapter()]);
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('TargetManager.capture', () => {
  it('rejects missing / non-editable active elements', () => {
    expect(manager.capture(null).ok).toBe(false);
    expect(manager.capture(document.body).ok).toBe(false);
    const paragraph = document.createElement('p');
    document.body.appendChild(paragraph);
    const result = manager.capture(paragraph);
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/not a supported text field/);
  });

  it('rejects unsupported input types', () => {
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    document.body.appendChild(checkbox);
    expect(manager.capture(checkbox).ok).toBe(false);
  });

  it('routes form controls and contenteditable to the right adapter', () => {
    const input = document.createElement('input');
    input.type = 'text';
    input.value = 'abc';
    document.body.appendChild(input);
    expect(manager.capture(input).ok).toBe(true);
    expect(manager.summary()?.kind).toBe('input');

    const editor = document.createElement('div');
    editor.setAttribute('contenteditable', 'true');
    editor.textContent = 'abc';
    document.body.appendChild(editor);
    stubSelection(null);
    expect(manager.capture(editor).ok).toBe(true);
    expect(manager.summary()?.kind).toBe('contenteditable');
  });
});

describe('TargetManager.commit', () => {
  it('commits through the form-control adapter at the captured caret', () => {
    const input = document.createElement('input');
    input.type = 'text';
    input.value = 'Hello world';
    document.body.appendChild(input);
    input.setSelectionRange(5, 5);
    manager.capture(input);

    const result = manager.commit(' beautiful');
    expect(result.ok).toBe(true);
    expect(input.value).toBe('Hello beautiful world');
  });

  it('commits through the contenteditable adapter', () => {
    const editor = document.createElement('div');
    editor.setAttribute('contenteditable', 'true');
    editor.textContent = 'Hello world';
    document.body.appendChild(editor);
    stubSelection(null); // capture → end of content
    manager.capture(editor);

    const result = manager.commit(' again');
    expect(result.ok).toBe(true);
    expect(editor.textContent).toBe('Hello world again');
  });

  it('replaces the previous final without appending a duplicate', () => {
    const input = document.createElement('input');
    input.type = 'text';
    input.value = 'Hello';
    document.body.appendChild(input);
    input.setSelectionRange(5, 5);
    manager.capture(input);

    expect(manager.commit(' th').ok).toBe(true);
    expect(manager.replace(' this is the second test', ' th').ok).toBe(true);
    expect(input.value).toBe('Hello this is the second test');
  });

  it('fails after clear() and when the element disappeared', () => {
    const input = document.createElement('input');
    input.type = 'text';
    input.value = 'abc';
    document.body.appendChild(input);
    manager.capture(input);

    manager.clear();
    expect(manager.commit('x').ok).toBe(false);

    manager.capture(input);
    input.remove();
    expect(manager.commit('x').ok).toBe(false);
  });
});

describe('TargetManager.validate', () => {
  it('reports invalid targets before insertion is attempted', () => {
    const input = document.createElement('input');
    input.type = 'text';
    input.value = 'abc';
    document.body.appendChild(input);
    manager.capture(input);

    expect(manager.validate().ok).toBe(true);
    input.disabled = true;
    expect(manager.validate().ok).toBe(false);
  });
});

describe('TargetManager.adapterFor routing with site adapters', () => {
  // Regression: GoogleKeepAdapter is host-gated (keep.google.com only) but
  // shares the 'contenteditable' kind. On other sites every commit used to be
  // routed to it and failed with "element is no longer editable".
  it('routes contenteditable targets to an adapter that canHandle the element', () => {
    const managerWithKeep = new TargetManager(
      [new FormControlAdapter(), new GoogleKeepAdapter('mail.google.com'), new ContentEditableAdapter()]
    );

    const editor = document.createElement('div');
    editor.setAttribute('contenteditable', 'true');
    editor.textContent = 'abc';
    document.body.appendChild(editor);
    stubSelection(null);
    expect(managerWithKeep.capture(editor).ok).toBe(true);

    const commit = managerWithKeep.commit(' ghi');
    expect(commit.ok).toBe(true);
    expect(editor.textContent).toBe('abc ghi');
  });

  it('still falls back to the kind-match when no canHandle matches (precise errors)', () => {
    const managerWithKeep = new TargetManager(
      [new FormControlAdapter(), new GoogleKeepAdapter('mail.google.com'), new ContentEditableAdapter()]
    );

    const editor = document.createElement('div');
    editor.setAttribute('contenteditable', 'true');
    editor.textContent = 'abc';
    document.body.appendChild(editor);
    stubSelection(null);
    expect(managerWithKeep.capture(editor).ok).toBe(true);
    editor.remove();

    const result = managerWithKeep.commit('x');
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/removed/);
  });
});

describe('TargetManager session spacing', () => {
  it('keeps previews and finals consistently spaced across captures', () => {
    const input = document.createElement('textarea');
    input.value = 'hello ';
    document.body.appendChild(input);
    input.focus();
    input.setSelectionRange(6, 6);
    manager.capture(input);
    manager.preview('world');
    expect(input.value).toBe('hello world');
    manager.commit('world');
    expect(input.value).toBe('hello world');
    manager.resetPreview();
    manager.capture(input);
    manager.preview('again');
    expect(input.value).toBe('hello world again');
    manager.preview('again today');
    manager.commit('again today');
    expect(input.value).toBe('hello world again today');
  });

  it('repairs a Keep range before calculating the word boundary', () => {
    const keep = new GoogleKeepAdapter('keep.google.com');
    const targets = new TargetManager([keep]);
    const editor = document.createElement('div');
    editor.setAttribute('contenteditable', 'false');
    editor.setAttribute('role', 'combobox');
    editor.setAttribute('aria-autocomplete', 'list');
    editor.innerHTML = '<p>I</p>';
    document.body.append(editor);
    const range = document.createRange();
    range.setStart(editor.querySelector('p')!.firstChild!, 1);
    range.collapse(true);
    stubSelection(range);

    try {
      expect(targets.capture(editor).ok).toBe(true);
      const target = (targets as unknown as { current: Extract<InsertionTarget, { type: 'contenteditable' }> }).current;
      target.range.setStart(editor, 0);
      target.range.collapse(true);

      expect(targets.commit('want to test').ok).toBe(true);
      expect(editor.textContent).toBe('I want to test');
    } finally {
      keep.dispose();
    }
  });

  it('does not add a space at the start of a new Keep paragraph', () => {
    const keep = new GoogleKeepAdapter('keep.google.com');
    const targets = new TargetManager([keep]);
    const editor = document.createElement('div');
    editor.setAttribute('contenteditable', 'true');
    const previous = document.createElement('p');
    previous.textContent = 'previous';
    const current = document.createElement('p');
    editor.append(previous, current);
    document.body.append(editor);
    const range = document.createRange();
    range.setStart(current, 0);
    range.collapse(true);
    stubSelection(range);
    try {
      targets.capture(editor);
      targets.preview('hello');
      targets.commit('hello world');
      expect(previous.textContent).toBe('previous');
      expect(current.textContent).toBe('hello world');
    } finally {
      keep.dispose();
    }
  });
});

describe('TargetManager.preview', () => {
  it('previews through the routed adapter and fails without a capture', () => {
    expect(manager.preview('x').ok).toBe(false);

    const input = document.createElement('input');
    input.type = 'text';
    document.body.appendChild(input);
    manager.capture(input);
    expect(manager.preview('hi').ok).toBe(true);
    expect(input.value).toBe('hi');

    manager.clear();
    expect(manager.preview('x').ok).toBe(false);
  });

  it('resetPreview is safe without a capture', () => {
    expect(() => manager.resetPreview()).not.toThrow();
  });

  it('routes contenteditable previews to the contenteditable adapter', () => {
    const editor = document.createElement('div');
    editor.setAttribute('contenteditable', 'true');
    editor.textContent = 'abc';
    document.body.appendChild(editor);
    stubSelection(null);
    manager.capture(editor);
    expect(manager.preview(' def').ok).toBe(true);
    expect(editor.textContent).toBe('abc def');
  });
});

describe('buildSelector', () => {
  it('prefers id and falls back to a short tag path', () => {
    const withId = document.createElement('input');
    withId.id = 'target-field';
    document.body.appendChild(withId);
    expect(buildSelector(withId)).toBe('#target-field');

    const plain = document.createElement('textarea');
    document.body.appendChild(plain);
    expect(buildSelector(plain)).toContain('textarea');
  });
});
