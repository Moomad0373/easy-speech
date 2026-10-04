import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GoogleKeepAdapter, isKeepHost } from '../src/content/insertion/GoogleKeepAdapter';
import type { InsertionTarget } from '../src/shared/types';

let host: string;

function makeAdapter(): GoogleKeepAdapter {
  return new GoogleKeepAdapter(host);
}

function makeEditor(html: string): HTMLDivElement {
  const div = document.createElement('div');
  div.id = 'editor';
  div.setAttribute('contenteditable', 'true');
  div.setAttribute('role', 'textbox'); // Keep's editors look like this
  div.innerHTML = html; // test scaffolding only, never transcript data
  document.body.appendChild(div);
  return div;
}

/**
 * Keep's newer Docs-derived note-body editor: NOT contenteditable — a
 * focusable combobox root wrapping the note's paragraphs (observed DOM).
 */
function makeComboboxEditor(html: string): HTMLDivElement {
  const div = document.createElement('div');
  div.id = 'keep-body-editor';
  div.setAttribute('tabindex', '0');
  div.setAttribute('contenteditable', 'false');
  div.setAttribute('role', 'combobox');
  div.setAttribute('aria-autocomplete', 'list');
  div.innerHTML = html; // test scaffolding only, never transcript data
  document.body.appendChild(div);
  return div;
}

/**
 * Dump shape of a live checklist note: sibling checklist items, each its OWN
 * combobox root (role=combobox, contenteditable=false, aria-autocomplete=list,
 * aria-label="list item") holding one canonical <p><span data-ri> — never one
 * shared root with several paragraphs.
 */
function makeChecklistNote(items: string[]): HTMLDivElement[] {
  return items.map((text) => {
    const item = makeComboboxEditor(`<p><span data-ri="0">${text}</span></p>`);
    item.setAttribute('aria-label', 'list item');
    return item;
  });
}

function stubSelection(range: Range | null, active: Element | null = null): void {
  const selection = {
    rangeCount: range ? 1 : 0,
    getRangeAt: () => range,
    removeAllRanges: vi.fn(),
    addRange: vi.fn(),
  };
  vi.spyOn(window, 'getSelection').mockReturnValue(selection as unknown as Selection);
  if (active) {
    Object.defineProperty(document, 'activeElement', { value: active, configurable: true });
  }
}

function collapsedRangeIn(node: Node, offset: number): Range {
  const range = document.createRange();
  range.setStart(node, offset);
  range.setEnd(node, offset);
  return range;
}

/** Stale range pointing at a node no longer inside the editor. */
function detachedRange(): Range {
  const orphan = document.createTextNode('old');
  const range = document.createRange();
  range.setStart(orphan, 0);
  range.setEnd(orphan, 0);
  return range;
}

beforeEach(() => {
  document.body.innerHTML = '';
  vi.restoreAllMocks();
  delete (document.activeElement as { activeElement?: Element }).activeElement;
  Object.defineProperty(document, 'activeElement', { value: document.body, configurable: true });
});

describe('Keep paragraph and session regressions', () => {
  it('replaces an early partial final with its corrected cumulative result', () => {
    host = 'keep.google.com';
    const adapter = makeAdapter();
    const editor = makeComboboxEditor('<p></p>');
    const range = document.createRange();
    range.setStart(editor.querySelector('p')!, 0);
    range.collapse(true);
    stubSelection(range, editor);
    const target = adapter.captureTarget(editor) as InsertionTarget;

    try {
      expect(adapter.insertText(target, ' th').ok).toBe(true);
      expect(adapter.replaceText(target, ' this is the second test', ' th').ok).toBe(true);
      expect(editor.textContent).toBe('this is the second test');
    } finally {
      adapter.dispose();
    }
  });

  it('falls back to the new suffix when Enter moved away from an early final', () => {
    host = 'keep.google.com';
    const adapter = makeAdapter();
    const editor = makeComboboxEditor('<p></p>');
    const range = document.createRange();
    range.setStart(editor.querySelector('p')!, 0);
    range.collapse(true);
    stubSelection(range, editor);
    const target = adapter.captureTarget(editor) as InsertionTarget;

    try {
      expect(adapter.insertText(target, 'I').ok).toBe(true);
      editor.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', shiftKey: true, bubbles: true }));
      const second = document.createElement('p');
      editor.appendChild(second);
      stubSelection(collapsedRangeIn(second, 0), editor);
      document.dispatchEvent(new Event('selectionchange'));

      expect(adapter.replaceText(target, ' I want to test this extension', ' I').ok).toBe(true);
      expect(Array.from(editor.querySelectorAll('p'), (p) => p.textContent)).toEqual(['I', 'want to test this extension']);
    } finally {
      adapter.dispose();
    }
  });

  it('replaces an early partial final after Keep rebuilds the editor', () => {
    host = 'keep.google.com';
    const adapter = makeAdapter();
    const editor = makeComboboxEditor('<p></p>');
    const range = document.createRange();
    range.setStart(editor.querySelector('p')!, 0);
    range.collapse(true);
    stubSelection(range, editor);
    editor.addEventListener('input', () => {
      for (const paragraph of Array.from(editor.querySelectorAll('p'))) {
        paragraph.replaceChildren(document.createTextNode(paragraph.textContent ?? ''));
      }
    });
    const target = adapter.captureTarget(editor) as InsertionTarget;

    try {
      expect(adapter.insertText(target, ' th').ok).toBe(true);
      expect(editor.textContent).toBe('th');
      expect(adapter.replaceText(target, ' this is the second test', ' th').ok).toBe(true);
      expect(editor.textContent).toBe('this is the second test');
    } finally {
      adapter.dispose();
    }
  });

  it('does not release a preview that Keep already removed from its model', () => {
    host = 'keep.google.com';
    const adapter = makeAdapter();
    const editor = makeComboboxEditor('<p>base</p>');
    stubSelection(collapsedRangeIn(editor.querySelector('p')!.firstChild!, 4), editor);
    const target = adapter.captureTarget(editor) as InsertionTarget;
    editor.addEventListener('input', () => {
      const paragraph = editor.querySelector('p')!;
      paragraph.textContent = 'base';
    });

    try {
      expect(adapter.previewText(target, ' spoken').ok).toBe(true);
      expect(editor.textContent).toBe('base');
      editor.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', shiftKey: true, bubbles: true }));
      const second = document.createElement('p');
      editor.appendChild(second);
      stubSelection(collapsedRangeIn(second, 0), editor);
      document.dispatchEvent(new Event('selectionchange'));

      expect(adapter.previewText(target, ' next').ok).toBe(true);
      expect(Array.from(editor.querySelectorAll('p'), (p) => p.textContent)).toEqual(['base', 'next']);
    } finally {
      adapter.dispose();
    }
  });

  it('keeps a rebuilt preview entirely inside the empty second paragraph', () => {
    host = 'keep.google.com';
    const adapter = makeAdapter();
    const editor = makeComboboxEditor('<p>previous</p><p></p><p>untouched</p>');
    stubSelection(collapsedRangeIn(editor.children[1]!, 0), editor);
    const target = adapter.captureTarget(editor) as InsertionTarget;
    editor.addEventListener('input', () => {
      for (const paragraph of Array.from(editor.children)) {
        paragraph.replaceChildren(document.createTextNode(paragraph.textContent ?? ''));
      }
    });
    try {
      expect(adapter.previewText(target, 'first').ok).toBe(true);
      expect(adapter.previewText(target, 'first second').ok).toBe(true);
      expect(adapter.insertText(target, 'first second').ok).toBe(true);
      expect(Array.from(editor.children, (p) => p.textContent)).toEqual(['previous', 'first second', 'untouched']);
    } finally {
      adapter.dispose();
    }
  });
});

describe('Keep manual caret ownership', () => {
  function select(node: Node, offset: number): void {
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(collapsedRangeIn(node, offset));
  }

  function expectCaret(node: Node, offset: number): void {
    const range = window.getSelection()!.getRangeAt(0);
    expect(range.collapsed).toBe(true);
    expect(range.startContainer).toBe(node);
    expect(range.startOffset).toBe(offset);
  }

  beforeEach(() => {
    host = 'keep.google.com';
    vi.spyOn(Date, 'now').mockReturnValue(1000);
  });

  it.each(['preview', 'final'] as const)('adopts an empty paragraph after same-tick Shift+Enter for the next %s', (operation) => {
    const adapter = makeAdapter();
    const editor = makeComboboxEditor('<p>English</p><p>untouched</p>');
    Object.defineProperty(document, 'activeElement', { value: editor, configurable: true });
    select(editor.firstChild!.firstChild!, 7);
    const target = adapter.captureTarget(editor) as InsertionTarget;
    const secondLine = document.createElement('p');
    try {
      expect(adapter.previewText(target, ' فارسی').ok).toBe(true);
      expect(editor.firstChild!.textContent).toBe('English فارسی');
      editor.addEventListener('keydown', (event) => {
        if (event.key !== 'Enter' || !event.shiftKey) return;
        event.stopPropagation();
        editor.insertBefore(secondLine, editor.lastChild);
        select(secondLine, 0);
      });
      editor.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', shiftKey: true, bubbles: true }));
      adapter.resetPreview(target);
      expect(editor.firstChild!.textContent).toBe('English فارسی');
      expect(secondLine.textContent).toBe('');
      expectCaret(secondLine, 0);
      const result = operation === 'preview' ? adapter.previewText(target, 'سلام') : adapter.insertText(target, 'سلام');
      expect(result.ok).toBe(true);
      expect(Array.from(editor.children, (p) => p.textContent)).toEqual(['English فارسی', 'سلام', 'untouched']);
      expect(secondLine.contains(window.getSelection()!.anchorNode)).toBe(true);
    } finally {
      adapter.dispose();
    }
  });

  it('adopts the element caret after BR without moving it to the previous line', () => {
    const adapter = makeAdapter();
    const editor = makeComboboxEditor('<p>English</p>');
    const paragraph = editor.firstChild!;
    Object.defineProperty(document, 'activeElement', { value: editor, configurable: true });
    select(paragraph.firstChild!, 7);
    const target = adapter.captureTarget(editor) as InsertionTarget;
    try {
      expect(adapter.previewText(target, ' فارسی').ok).toBe(true);
      editor.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', shiftKey: true, bubbles: true }));
      adapter.resetPreview(target);
      const br = document.createElement('br');
      paragraph.appendChild(br);
      select(paragraph, paragraph.childNodes.length);
      expect(paragraph.textContent).toBe('English فارسی');
      expect(adapter.textBeforeCaret(target).endsWith('\n')).toBe(true);
      expect(adapter.previewText(target, 'سلام').ok).toBe(true);
      expect(paragraph.textContent).toBe('English فارسیسلام');
      expectCaret(paragraph, paragraph.childNodes.length);
      expect(adapter.insertText(target, 'سلام دنیا').ok).toBe(true);
      expect(br.nextSibling!.textContent).toBe('سلام دنیا');
      expect(paragraph.textContent).toBe('English فارسیسلام دنیا');
    } finally {
      adapter.dispose();
    }
  });

  it.each(['preview', 'final'] as const)('preserves manually extended preview text after resetPreview and a new %s', (operation) => {
    const adapter = makeAdapter();
    const editor = makeComboboxEditor('<p>English</p>');
    Object.defineProperty(document, 'activeElement', { value: editor, configurable: true });
    select(editor.firstChild!.firstChild!, 7);
    const target = adapter.captureTarget(editor) as Extract<InsertionTarget, { type: 'contenteditable' }>;
    try {
      expect(adapter.previewText(target, ' فارسی').ok).toBe(true);
      const preview = target.previewNode!;
      editor.dispatchEvent(new KeyboardEvent('keydown', { key: '؟', bubbles: true }));
      adapter.resetPreview(target);
      expect(target.previewNode).toBeNull();
      expect(target.previewText).toBeNull();
      expect(target.previewOffset).toBeNull();
      expect(editor.textContent).toBe('English فارسی');
      preview.appendData('؟');
      select(preview, preview.length);
      expect(editor.textContent).toBe('English فارسی؟');
      const result = operation === 'preview' ? adapter.previewText(target, ' بعدی') : adapter.insertText(target, ' بعدی');
      expect(result.ok).toBe(true);
      expect(editor.textContent).toBe('English فارسی؟ بعدی');
    } finally {
      adapter.dispose();
    }
  });

  it('releases preview tracking before a user gesture can mutate its node', () => {
    const adapter = makeAdapter();
    const editor = makeComboboxEditor('<p>one</p>');
    Object.defineProperty(document, 'activeElement', { value: editor, configurable: true });
    select(editor.firstChild!.firstChild!, 3);
    const target = adapter.captureTarget(editor) as Extract<InsertionTarget, { type: 'contenteditable' }>;
    try {
      expect(adapter.previewText(target, ' two').ok).toBe(true);
      const preview = target.previewNode!;
      let trackingDuringKey: Text | null | undefined;
      editor.addEventListener('keydown', (event) => {
        event.stopPropagation();
        trackingDuringKey = target.previewNode;
        preview.appendData('!');
        select(preview, preview.length);
      });
      editor.dispatchEvent(new KeyboardEvent('keydown', { key: '!', bubbles: true }));
      expect(trackingDuringKey).toBeNull();
      expect(editor.textContent).toBe('one two!');
      expect(adapter.previewText(target, ' three').ok).toBe(true);
      expect(editor.textContent).toBe('one two! three');
    } finally {
      adapter.dispose();
    }
  });

  it.each(['keydown', 'pointerdown'])('disarms repairs in capture phase on same-tick %s', async (type) => {
    vi.useFakeTimers();
    const adapter = makeAdapter();
    const editor = makeComboboxEditor('<p>one</p><p></p>');
    Object.defineProperty(document, 'activeElement', { value: editor, configurable: true });
    select(editor.firstChild!.firstChild!, 3);
    const target = adapter.captureTarget(editor) as InsertionTarget;
    const empty = editor.lastChild!;
    try {
      expect(adapter.previewText(target, ' two').ok).toBe(true);
      let caretDuringGesture: Node | null = null;
      editor.addEventListener(type, (event) => {
        event.stopPropagation();
        select(empty, 0);
        document.dispatchEvent(new Event('selectionchange'));
        caretDuringGesture = window.getSelection()!.anchorNode;
      });
      editor.dispatchEvent(type === 'keydown'
        ? new KeyboardEvent(type, { key: 'Enter', shiftKey: true, bubbles: true })
        : new Event(type, { bubbles: true }));
      expect(caretDuringGesture).toBe(empty);
      expectCaret(empty, 0);
      empty.appendChild(document.createElement('br'));
      await vi.runAllTimersAsync();
      document.dispatchEvent(new Event('selectionchange'));
      expectCaret(empty, 0);
      expect(editor.firstChild!.textContent).toBe('one two');
    } finally {
      adapter.dispose();
      vi.useRealTimers();
    }
  });

  it('preserves the exact post-insertion boundary across deferred repairs', () => {
    vi.useFakeTimers();
    const adapter = makeAdapter();
    const editor = makeComboboxEditor('<p>previous</p><p></p>');
    const paragraph = editor.lastChild!;
    Object.defineProperty(document, 'activeElement', { value: editor, configurable: true });
    select(paragraph, 0);
    const target = adapter.captureTarget(editor) as InsertionTarget;
    try {
      expect(adapter.previewText(target, 'فارسی').ok).toBe(true);
      expectCaret(paragraph, 1);
      vi.runAllTimers();
      expectCaret(paragraph, 1);
      expect(adapter.insertText(target, 'فارسی\nnext').ok).toBe(true);
      expectCaret(paragraph, 3);
      vi.runAllTimers();
      expectCaret(paragraph, 3);
    } finally {
      adapter.dispose();
      vi.useRealTimers();
    }
  });

  it('keeps beforeinput and input notifications for every preview update and final', () => {
    const adapter = makeAdapter();
    const editor = makeComboboxEditor('<p></p>');
    select(editor.firstChild!, 0);
    const target = adapter.captureTarget(editor) as Extract<InsertionTarget, { type: 'contenteditable' }>;
    const events: Array<[string, string | null, boolean, string | null, string | null]> = [];
    for (const type of ['beforeinput', 'input']) {
      editor.addEventListener(type, (event) => {
        const input = event as InputEvent;
        events.push([
          event.type,
          editor.textContent,
          event.bubbles,
          input.inputType ?? null,
          input.data ?? null,
        ]);
      });
    }
    try {
      expect(adapter.previewText(target, 'فار').ok).toBe(true);
      expect(adapter.previewText(target, 'فارسی').ok).toBe(true);
      expect(adapter.insertText(target, 'فارسی نهایی').ok).toBe(true);
      expect(events).toEqual([
        ['beforeinput', 'فار', true, 'insertText', 'فار'], ['input', 'فار', true, 'insertText', 'فار'],
        ['beforeinput', 'فارسی', true, 'insertText', 'فارسی'], ['input', 'فارسی', true, 'insertText', 'فارسی'],
        ['beforeinput', 'فارسی نهایی', true, 'insertText', 'فارسی نهایی'], ['input', 'فارسی نهایی', true, 'insertText', 'فارسی نهایی'],
      ]);
    } finally {
      adapter.dispose();
    }
  });
});

describe('Keep delayed final after a manual gesture', () => {
  function select(node: Node, offset: number): void {
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(collapsedRangeIn(node, offset));
  }

  beforeEach(() => {
    host = 'keep.google.com';
  });

  it('does not duplicate the released interim words when the final matches', () => {
    const adapter = makeAdapter();
    const editor = makeComboboxEditor('<p>English</p>');
    Object.defineProperty(document, 'activeElement', { value: editor, configurable: true });
    select(editor.querySelector('p')!.firstChild!, 7);
    const target = adapter.captureTarget(editor) as Extract<InsertionTarget, { type: 'contenteditable' }>;

    expect(adapter.previewText(target, ' فارسی').ok).toBe(true);
    expect(editor.textContent).toBe('English فارسی');

    // Mid-utterance the user types a period (the browser inserts it at the
    // caret, extending the preview's own text node).
    const previewNode = target.previewNode!;
    editor.dispatchEvent(new KeyboardEvent('keydown', { key: '.', bubbles: true }));
    previewNode.appendData('.');
    select(previewNode, previewNode.length);
    expect(editor.textContent).toBe('English فارسی.');

    // The delayed final for that utterance must not re-insert the words.
    expect(adapter.insertText(target, ' فارسی').ok).toBe(true);
    expect(editor.textContent).toBe('English فارسی.');
    adapter.dispose();
  });

  it('inserts only the words the final adds beyond the released interim', () => {
    const adapter = makeAdapter();
    const editor = makeComboboxEditor('<p>English</p>');
    Object.defineProperty(document, 'activeElement', { value: editor, configurable: true });
    select(editor.querySelector('p')!.firstChild!, 7);
    const target = adapter.captureTarget(editor) as Extract<InsertionTarget, { type: 'contenteditable' }>;

    expect(adapter.previewText(target, ' فار').ok).toBe(true);
    const previewNode = target.previewNode!;
    editor.dispatchEvent(new KeyboardEvent('keydown', { key: '.', bubbles: true }));
    previewNode.appendData('.');
    select(previewNode, previewNode.length);

    expect(adapter.insertText(target, ' فارسی').ok).toBe(true);
    expect(editor.textContent).toBe('English فارسی.');
    adapter.dispose();
  });

  it('grows the released phrase when Keep rewrites its spaces to nbsp', () => {
    const adapter = makeAdapter();
    const editor = makeComboboxEditor('<p>English</p>');
    Object.defineProperty(document, 'activeElement', { value: editor, configurable: true });
    select(editor.querySelector('p')!.firstChild!, 7);
    const target = adapter.captureTarget(editor) as Extract<InsertionTarget, { type: 'contenteditable' }>;

    expect(adapter.previewText(target, ' hello').ok).toBe(true);
    expect(editor.textContent).toBe('English hello');

    // Any gesture releases the pending preview into the user's text.
    editor.dispatchEvent(new KeyboardEvent('keydown', { key: 'x', bubbles: true }));

    // Keep's renderer normalizes ordinary spaces to non-breaking spaces
    // (observed live: `&nbsp;this is a test` in a checklist item).
    const paragraph = editor.querySelector('p')!;
    for (const node of paragraph.childNodes) {
      if (node.nodeType === Node.TEXT_NODE) {
        node.textContent = (node.textContent ?? '').replace(/ /g, ' ');
      }
    }
    expect(editor.textContent).toBe('English hello');

    // The delayed final grows the released phrase; it must not re-insert
    // the whole transcript beside the nbsp-rewritten tail.
    expect(adapter.insertText(target, ' hello there').ok).toBe(true);
    expect(editor.textContent).toBe('English hello there');
    adapter.dispose();
  });

  it('keeps the caret on the new line while the pending phrase completes', () => {
    const adapter = makeAdapter();
    const editor = makeComboboxEditor('<p>line one</p>');
    Object.defineProperty(document, 'activeElement', { value: editor, configurable: true });
    select(editor.querySelector('p')!.firstChild!, 8);
    const target = adapter.captureTarget(editor) as InsertionTarget;

    expect(adapter.previewText(target, ' فار').ok).toBe(true);
    editor.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', shiftKey: true, bubbles: true }));
    // The browser applies Shift+Enter: a new paragraph, caret moved there.
    const second = document.createElement('p');
    editor.appendChild(second);
    select(second, 0);

    expect(adapter.insertText(target, ' فارسی').ok).toBe(true);
    expect(Array.from(editor.children, (p) => p.textContent)).toEqual(['line one فارسی', '']);
    expect(window.getSelection()!.getRangeAt(0).startContainer).toBe(second);
    adapter.dispose();
  });

  it('commits at the user caret when the user typed inside the interim span', () => {
    const adapter = makeAdapter();
    const editor = makeComboboxEditor('<p>English</p>');
    Object.defineProperty(document, 'activeElement', { value: editor, configurable: true });
    select(editor.querySelector('p')!.firstChild!, 7);
    const target = adapter.captureTarget(editor) as Extract<InsertionTarget, { type: 'contenteditable' }>;

    expect(adapter.previewText(target, ' فار').ok).toBe(true);
    const previewNode = target.previewNode!;
    editor.dispatchEvent(new KeyboardEvent('keydown', { key: '.', bubbles: true }));
    previewNode.data = ' فا.ر';
    select(previewNode, 5);

    expect(adapter.insertText(target, ' فارسی').ok).toBe(true);
    expect(editor.textContent).toBe('English فا.ر فارسی');
    adapter.dispose();
  });

  it('never duplicates the phrase when the interim repeats after Enter', () => {
    const adapter = makeAdapter();
    const editor = makeComboboxEditor('<p></p>');
    Object.defineProperty(document, 'activeElement', { value: editor, configurable: true });
    select(editor.querySelector('p')!, 0);
    const target = adapter.captureTarget(editor) as Extract<InsertionTarget, { type: 'contenteditable' }>;

    expect(adapter.previewText(target, 'this is a good idea that').ok).toBe(true);
    expect(editor.textContent).toBe('this is a good idea that');

    // Enter mid-utterance releases the interim words to the user.
    editor.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    const second = document.createElement('p');
    editor.appendChild(second);
    select(second, 0);

    // Chrome's live result still holds the same utterance — the interim
    // arrives AGAIN. It must not become a second copy on the new line.
    expect(adapter.previewText(target, 'this is a good idea that').ok).toBe(true);
    expect(adapter.previewText(target, 'this is a good idea that').ok).toBe(true);
    expect(Array.from(editor.children, (p) => p.textContent)).toEqual(['this is a good idea that', '']);

    // The final for that utterance must not add the words a second time.
    expect(adapter.insertText(target, 'this is a good idea that').ok).toBe(true);
    expect(Array.from(editor.children, (p) => p.textContent)).toEqual(['this is a good idea that', '']);
    expect(window.getSelection()!.getRangeAt(0).startContainer).toBe(second);
    adapter.dispose();
  });

  it('starts a new utterance on the new line with the caret after it', () => {
    const adapter = makeAdapter();
    const editor = makeComboboxEditor('<p></p>');
    Object.defineProperty(document, 'activeElement', { value: editor, configurable: true });
    select(editor.querySelector('p')!, 0);
    const target = adapter.captureTarget(editor) as Extract<InsertionTarget, { type: 'contenteditable' }>;

    expect(adapter.previewText(target, 'this is a good idea that').ok).toBe(true);
    editor.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    const second = document.createElement('p');
    editor.appendChild(second);
    select(second, 0);

    // The pending phrase is done; the NEXT spoken phrase is new text.
    expect(adapter.previewText(target, ' will come to this show').ok).toBe(true);
    expect(Array.from(editor.children, (p) => p.textContent)).toEqual([
      'this is a good idea that',
      'will come to this show',
    ]);
    const live = window.getSelection()!.getRangeAt(0);
    expect(second.contains(live.startContainer)).toBe(true);
    expect(adapter.insertText(target, ' will come to this show').ok).toBe(true);
    expect(Array.from(editor.children, (p) => p.textContent)).toEqual([
      'this is a good idea that',
      'will come to this show',
    ]);
    adapter.dispose();
  });

  it('continues the released phrase with only the new words at the user caret', () => {
    const adapter = makeAdapter();
    const editor = makeComboboxEditor('<p></p>');
    Object.defineProperty(document, 'activeElement', { value: editor, configurable: true });
    select(editor.querySelector('p')!, 0);
    const target = adapter.captureTarget(editor) as Extract<InsertionTarget, { type: 'contenteditable' }>;

    expect(adapter.previewText(target, 'this is a good idea that').ok).toBe(true);
    editor.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    const second = document.createElement('p');
    editor.appendChild(second);
    select(second, 0);

    // The utterance keeps growing after the Enter: only the new words appear,
    // and they appear on the line the user moved to (the words were spoken
    // after the break — the user pressed Shift+Enter to continue there).
    expect(adapter.previewText(target, 'this is a good idea that will come').ok).toBe(true);
    expect(editor.querySelector('p')!.textContent).toBe('this is a good idea that');
    expect(second.textContent).toBe('will come');

    expect(adapter.insertText(target, 'this is a good idea that will come to this show').ok).toBe(true);
    expect(editor.querySelector('p')!.textContent).toBe('this is a good idea that');
    expect(second.textContent).toBe('will come to this show');
    adapter.dispose();
  });

  it('commits beside text the user typed into the preview node', () => {
    const adapter = makeAdapter();
    const editor = makeComboboxEditor('<p></p>');
    Object.defineProperty(document, 'activeElement', { value: editor, configurable: true });
    select(editor.querySelector('p')!, 0);
    const target = adapter.captureTarget(editor) as Extract<InsertionTarget, { type: 'contenteditable' }>;

    expect(adapter.previewText(target, 'hello').ok).toBe(true);
    const previewNode = target.previewNode!;
    previewNode.appendData(' WORLD');

    expect(adapter.insertText(target, 'hello there').ok).toBe(true);
    expect(editor.textContent).toBe('hello there WORLD');
    adapter.dispose();
  });

  it('grows the preview without dropping text the user typed into its node', () => {
    const adapter = makeAdapter();
    const editor = makeComboboxEditor('<p></p>');
    Object.defineProperty(document, 'activeElement', { value: editor, configurable: true });
    select(editor.querySelector('p')!, 0);
    const target = adapter.captureTarget(editor) as Extract<InsertionTarget, { type: 'contenteditable' }>;

    expect(adapter.previewText(target, 'hello').ok).toBe(true);
    const previewNode = target.previewNode!;
    previewNode.appendData(' WORLD');

    expect(adapter.previewText(target, 'hello there').ok).toBe(true);
    expect(editor.textContent).toBe('hello there WORLD');
    adapter.dispose();
  });
});

describe('Keep manual Shift+Enter across utterances (field-realistic focus)', () => {
  function select(node: Node, offset: number): void {
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(collapsedRangeIn(node, offset));
  }

  /** A selection mock that records asserted carets but exposes no live range. */
  function stubClearedSelection(): { lastAdded: Range | null } {
    const record = { lastAdded: null as Range | null };
    const selection = {
      rangeCount: 0,
      getRangeAt: () => {
        throw new Error('no ranges');
      },
      removeAllRanges: vi.fn(),
      addRange: (range: Range) => {
        record.lastAdded = range;
      },
    };
    vi.spyOn(window, 'getSelection').mockReturnValue(selection as unknown as Selection);
    return record;
  }

  /**
   * Field reality: the combobox root is contenteditable="false", so the
   * exact `activeElement === root` gate the base used never held — focus
   * sits on Keep's inner document layer, inside the editor but never the
   * root itself.
   */
  function stubInnerFocus(editor: HTMLElement): HTMLElement {
    const inner = document.createElement('div');
    editor.appendChild(inner);
    Object.defineProperty(document, 'activeElement', { value: inner, configurable: true });
    return inner;
  }

  beforeEach(() => {
    host = 'keep.google.com';
  });

  it('continues on the new line after a manual Shift+Enter even when the root never holds focus', () => {
    const adapter = makeAdapter();
    const editor = makeComboboxEditor('<p>English</p>');
    stubInnerFocus(editor);
    select(editor.querySelector('p')!.firstChild!, 7);
    const target = adapter.captureTarget(editor) as InsertionTarget;

    expect(adapter.previewText(target, ' فارسی').ok).toBe(true);
    expect(adapter.insertText(target, ' فارسی').ok).toBe(true);
    expect(editor.querySelector('p')!.textContent).toBe('English فارسی');

    // Manual Shift+Enter: the browser applies it after the keydown — a new
    // paragraph, caret moved there — and the following selectionchange is
    // the only moment the post-break caret is observable.
    const second = document.createElement('p');
    editor.appendChild(second);
    editor.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', shiftKey: true, bubbles: true }));
    select(second, 0);
    document.dispatchEvent(new Event('selectionchange'));
    // Keep's rebuild clears the selection right after the break.
    const carets = stubClearedSelection();

    expect(adapter.previewText(target, ' سلام').ok).toBe(true);
    expect(Array.from(editor.querySelectorAll('p'), (p) => p.textContent)).toEqual(['English فارسی', 'سلام']);
    expect(carets.lastAdded && second.contains(carets.lastAdded.startContainer)).toBe(true);

    expect(adapter.insertText(target, ' سلام دنیا').ok).toBe(true);
    expect(Array.from(editor.querySelectorAll('p'), (p) => p.textContent)).toEqual(['English فارسی', 'سلام دنیا']);
    expect(carets.lastAdded && second.contains(carets.lastAdded.startContainer)).toBe(true);
    adapter.dispose();
  });

  it('continuation after the break lands on the new line when the selection was cleared', () => {
    const adapter = makeAdapter();
    const editor = makeComboboxEditor('<p></p>');
    stubInnerFocus(editor);
    select(editor.querySelector('p')!, 0);
    const target = adapter.captureTarget(editor) as InsertionTarget;

    expect(adapter.previewText(target, 'this is a good idea that').ok).toBe(true);
    editor.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    const second = document.createElement('p');
    editor.appendChild(second);
    select(second, 0);
    document.dispatchEvent(new Event('selectionchange'));
    stubClearedSelection();

    // The utterance keeps growing after the Enter: the new words belong at
    // the caret the user moved to, and the delivered prefix stays put.
    expect(adapter.previewText(target, 'this is a good idea that will come').ok).toBe(true);
    expect(editor.querySelector('p')!.textContent).toBe('this is a good idea that');
    expect(second.textContent).toBe('will come');

    expect(adapter.insertText(target, 'this is a good idea that will come to this show').ok).toBe(true);
    expect(editor.querySelector('p')!.textContent).toBe('this is a good idea that');
    expect(second.textContent).toBe('will come to this show');
    adapter.dispose();
  });

  it('keeps a continuation off the combobox root when the post-Enter caret is an element position', () => {
    const adapter = makeAdapter();
    const editor = makeComboboxEditor('<p></p>');
    Object.defineProperty(document, 'activeElement', { value: editor, configurable: true });
    select(editor.querySelector('p')!, 0);
    const target = adapter.captureTarget(editor) as InsertionTarget;

    expect(adapter.previewText(target, 'hello').ok).toBe(true);
    editor.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    const second = document.createElement('p');
    editor.appendChild(second);
    // Keep's rebuild can leave the post-Enter selection as an element
    // position on the root (between the two <p>s), not inside either block.
    select(editor, 1);
    document.dispatchEvent(new Event('selectionchange'));
    stubClearedSelection();

    expect(adapter.insertText(target, 'hello world').ok).toBe(true);
    // The continuation must land inside a canonical <p> — never as a bare
    // text child of the combobox root (Keep drops it on the next sync).
    const bareText = [...editor.childNodes].filter(
      (n) => n.nodeType === Node.TEXT_NODE && (n.textContent ?? '').trim() !== ''
    );
    expect(bareText).toHaveLength(0);
    // Leading engine space is dropped at the start of the new block (same
    // rule as every plain insertion into an empty line).
    expect(Array.from(editor.querySelectorAll('p'), (p) => p.textContent)).toEqual(['hello', 'world']);
    adapter.dispose();
  });

  it('starts a new utterance on the new line via the captured caret alone', () => {
    const adapter = makeAdapter();
    const editor = makeComboboxEditor('<p>done</p>');
    stubInnerFocus(editor);
    select(editor.querySelector('p')!.firstChild!, 4);
    const target = adapter.captureTarget(editor) as InsertionTarget;

    expect(adapter.insertText(target, ' here').ok).toBe(true);
    editor.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', shiftKey: true, bubbles: true }));
    const second = document.createElement('p');
    editor.appendChild(second);
    select(second, 0);
    document.dispatchEvent(new Event('selectionchange'));
    stubClearedSelection();

    // The pending phrase is finished; the next spoken phrase is new text and
    // must follow the user's post-Enter caret even with no live selection.
    expect(adapter.previewText(target, ' next line text').ok).toBe(true);
    expect(Array.from(editor.querySelectorAll('p'), (p) => p.textContent)).toEqual(['done here', 'next line text']);
    adapter.dispose();
  });

  it('completes the interrupted word on the old line even when the user moved to a new one', () => {
    const adapter = makeAdapter();
    const editor = makeComboboxEditor('<p>line</p>');
    stubInnerFocus(editor);
    select(editor.querySelector('p')!.firstChild!, 4);
    const target = adapter.captureTarget(editor) as InsertionTarget;

    expect(adapter.previewText(target, ' فار').ok).toBe(true);
    editor.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', shiftKey: true, bubbles: true }));
    const second = document.createElement('p');
    editor.appendChild(second);
    select(second, 0);
    document.dispatchEvent(new Event('selectionchange'));

    // "فار" → "فارسی" is a mid-word completion (no leading whitespace): it
    // must finish the word where it started, not split it across the break.
    expect(adapter.insertText(target, ' فارسی').ok).toBe(true);
    expect(editor.querySelector('p')!.textContent).toBe('line فارسی');
    expect(second.textContent).toBe('');
    adapter.dispose();
  });

  it('follows the post-break caret onto the rebuilt line when Keep replaces the paragraph', () => {
    const adapter = makeAdapter();
    const editor = makeComboboxEditor('<p>English</p>');
    stubInnerFocus(editor);
    select(editor.querySelector('p')!.firstChild!, 7);
    const target = adapter.captureTarget(editor) as InsertionTarget;

    expect(adapter.insertText(target, ' فارسی').ok).toBe(true);
    editor.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', shiftKey: true, bubbles: true }));
    const second = document.createElement('p');
    editor.appendChild(second);
    select(second, 0);
    document.dispatchEvent(new Event('selectionchange'));
    // Keep's rebuild replaces the new paragraph (killing the snapshot's node
    // identity) and clears the selection. The block-anchored record maps the
    // caret to the SAME line of the rebuilt structure.
    const replacement = document.createElement('p');
    editor.appendChild(replacement);
    second.remove();
    const carets = stubClearedSelection();

    expect(adapter.previewText(target, ' سلام').ok).toBe(true);
    // Nothing was lost and the text followed the user's line, not the old one.
    expect(editor.querySelector('p')!.textContent).toBe('English فارسی');
    expect(replacement.textContent).toBe('سلام');
    expect(carets.lastAdded && replacement.contains(carets.lastAdded.startContainer)).toBe(true);
    adapter.dispose();
  });

  it('keeps following the user caret when a rebuild replaces every paragraph', () => {
    const adapter = makeAdapter();
    const editor = makeComboboxEditor('<p>first</p>');
    stubInnerFocus(editor);
    select(editor.querySelector('p')!.firstChild!, 5);
    const target = adapter.captureTarget(editor) as InsertionTarget;

    expect(adapter.insertText(target, ' here').ok).toBe(true);
    editor.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', shiftKey: true, bubbles: true }));
    const second = document.createElement('p');
    editor.appendChild(second);
    select(second, 0);
    document.dispatchEvent(new Event('selectionchange'));

    // A full rebuild: every <p> is replaced with fresh nodes (Keep's
    // renderer normalizes constantly), text and order preserved. The
    // captured caret must remap through the block anchor to the new second
    // paragraph — the numeric offset alone cannot tell "start of the new
    // empty line" from "end of the previous line" (they are the same
    // textContent offset).
    editor.replaceChildren();
    const rebuiltFirst = document.createElement('p');
    rebuiltFirst.textContent = 'first here';
    const rebuiltSecond = document.createElement('p');
    editor.appendChild(rebuiltFirst);
    editor.appendChild(rebuiltSecond);
    const carets = stubClearedSelection();

    expect(adapter.previewText(target, ' next').ok).toBe(true);
    expect(Array.from(editor.querySelectorAll('p'), (p) => p.textContent)).toEqual(['first here', 'next']);
    expect(carets.lastAdded && rebuiltSecond.contains(carets.lastAdded.startContainer)).toBe(true);
    adapter.dispose();
  });

  it('never moves the visible caret on a blind write while the user is editing', () => {
    const adapter = makeAdapter();
    const editor = makeComboboxEditor('<p>one</p>');
    stubInnerFocus(editor);
    select(editor.querySelector('p')!.firstChild!, 3);
    const target = adapter.captureTarget(editor) as InsertionTarget;

    expect(adapter.previewText(target, ' two').ok).toBe(true);
    // The user gestures; Keep clears the selection (no caret to capture) and
    // a rebuild detaches the tracked range before the next engine result.
    editor.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', shiftKey: true, bubbles: true }));
    const carets = stubClearedSelection();
    editor.replaceChildren(document.createElement('p'));
    editor.querySelector('p')!.textContent = 'one two';

    expect(adapter.previewText(target, ' more').ok).toBe(true);
    // The words still land (via the numeric anchor) but the user's caret is
    // theirs — the write must not drag the selection anywhere.
    expect(editor.querySelector('p')!.textContent).toBe('one two more');
    expect(carets.lastAdded).toBeNull();
    adapter.dispose();
  });

  it('never adopts a rebuild-artifact (root,0) selection even right after a gesture', () => {
    const adapter = makeAdapter();
    const editor = makeComboboxEditor('<p>one</p>');
    stubInnerFocus(editor);
    select(editor.querySelector('p')!.firstChild!, 3);
    const target = adapter.captureTarget(editor) as InsertionTarget;

    expect(adapter.previewText(target, ' two').ok).toBe(true);
    editor.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', shiftKey: true, bubbles: true }));
    editor.appendChild(document.createElement('p'));
    // A rebuild remaps the selection to the very start of the note.
    select(editor, 0);
    document.dispatchEvent(new Event('selectionchange'));

    expect(adapter.previewText(target, ' more').ok).toBe(true);
    // The artifact was never adopted — the words must not land at the START
    // of the note. With the fresh Enter gesture the placement follows the
    // line break the gesture created (inferred from the DOM, since the only
    // observable selection was the rebuild artifact).
    expect(Array.from(editor.querySelectorAll('p'), (p) => p.textContent)).toEqual(['one two', 'more']);
    adapter.dispose();
  });
});

describe('Keep manual Shift+Enter deletion and placement regressions', () => {
  function select(node: Node, offset: number): void {
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(collapsedRangeIn(node, offset));
  }

  /** A selection mock that records asserted carets but exposes no live range. */
  function stubClearedSelection(): void {
    const selection = {
      rangeCount: 0,
      getRangeAt: () => {
        throw new Error('no ranges');
      },
      removeAllRanges: vi.fn(),
      addRange: vi.fn(),
    };
    vi.spyOn(window, 'getSelection').mockReturnValue(selection as unknown as Selection);
  }

  function stubInnerFocus(editor: HTMLElement): void {
    const inner = document.createElement('div');
    editor.appendChild(inner);
    Object.defineProperty(document, 'activeElement', { value: inner, configurable: true });
  }

  beforeEach(() => {
    host = 'keep.google.com';
  });

  it('never deletes dictated text when a rebuild remaps the selection across it (non-collapsed, after a gesture)', () => {
    const adapter = makeAdapter();
    const editor = makeComboboxEditor('<p>one</p>');
    stubInnerFocus(editor);
    select(editor.querySelector('p')!.firstChild!, 3);
    const target = adapter.captureTarget(editor) as InsertionTarget;

    expect(adapter.previewText(target, ' two').ok).toBe(true);
    // Manual Shift+Enter; Chrome remaps the selection into a NON-COLLAPSED
    // range spanning the dictated words — the observed deletion vector: the
    // next result adopted the span and deleteContents() wiped it.
    editor.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', shiftKey: true, bubbles: true }));
    editor.appendChild(document.createElement('p'));
    const span = document.createRange();
    span.setStart(editor, 0);
    span.setEnd(editor, editor.childNodes.length);
    stubSelection(span);

    expect(adapter.previewText(target, ' more').ok).toBe(true);
    expect(Array.from(editor.querySelectorAll('p'), (p) => p.textContent)).toEqual(['one two', 'more']);
    adapter.dispose();
  });

  it('never deletes text when a stale non-collapsed selection exists without a fresh gesture', () => {
    const adapter = makeAdapter();
    const editor = makeComboboxEditor('<p>alpha</p><p>beta</p>');
    stubSelection(collapsedRangeIn(editor.querySelector('p')!.firstChild!, 5), editor);
    const target = adapter.captureTarget(editor) as InsertionTarget;

    expect(adapter.insertText(target, ' gamma').ok).toBe(true);
    expect(editor.querySelector('p')!.textContent).toBe('alpha gamma');

    // A rebuild leaves a NON-COLLAPSED selection spanning into the second
    // paragraph and there is no fresh user gesture: the tracked anchor must
    // own placement, and the span must NOT be adopted and deleted.
    const span = document.createRange();
    span.setStart(editor.querySelector('p')!.firstChild!, 5);
    span.setEnd(editor.querySelectorAll('p')[1]!.firstChild!, 4);
    stubSelection(span);

    expect(adapter.previewText(target, ' delta').ok).toBe(true);
    expect(Array.from(editor.querySelectorAll('p'), (p) => p.textContent)).toEqual(['alpha gamma delta', 'beta']);
    adapter.dispose();
  });

  it('clamps a non-collapsed captured selection to its start on the combobox root', () => {
    const adapter = makeAdapter();
    const editor = makeComboboxEditor('<p>alpha</p><p>beta</p>');
    const span = document.createRange();
    span.setStart(editor.querySelector('p')!.firstChild!, 5);
    span.setEnd(editor.querySelectorAll('p')[1]!.firstChild!, 4);
    stubSelection(span, editor);
    const target = adapter.captureTarget(editor) as Extract<InsertionTarget, { type: 'contenteditable' }>;

    expect(target.range.collapsed).toBe(true);
    expect(adapter.insertText(target, ' more').ok).toBe(true);
    // Dictation continues at the selection START — nothing spanning the
    // range was deleted.
    expect(Array.from(editor.querySelectorAll('p'), (p) => p.textContent)).toEqual(['alpha more', 'beta']);
    adapter.dispose();
  });

  it('still follows the late post-Enter caret after a blind write closed the gesture window', () => {
    const adapter = makeAdapter();
    const editor = makeComboboxEditor('<p>hold</p>');
    stubInnerFocus(editor);
    select(editor.querySelector('p')!.firstChild!, 4);
    const target = adapter.captureTarget(editor) as InsertionTarget;

    expect(adapter.insertText(target, ' one').ok).toBe(true);
    // The user presses Shift+Enter; Keep's rebuild clears the selection
    // BEFORE any selectionchange exposes the new caret, and the break is
    // not even applied yet when the next result arrives.
    editor.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', shiftKey: true, bubbles: true }));
    stubClearedSelection();

    // First result after the gesture: a blind write at the tracked anchor.
    expect(adapter.insertText(target, ' two').ok).toBe(true);
    expect(editor.querySelector('p')!.textContent).toBe('hold one two');

    // Only NOW does the break land and the browser expose the user's caret
    // on the new line. The pending caret capture must have survived the
    // blind write.
    const second = document.createElement('p');
    editor.appendChild(second);
    vi.restoreAllMocks();
    stubInnerFocus(editor);
    select(second, 0);
    document.dispatchEvent(new Event('selectionchange'));

    // The next utterance must follow the user's captured line, not the
    // numeric anchor (end of the previous line).
    expect(adapter.previewText(target, ' next').ok).toBe(true);
    expect(Array.from(editor.querySelectorAll('p'), (p) => p.textContent)).toEqual(['hold one two', 'next']);
    adapter.dispose();
  });

  it('places the continuation after the soft <br> break when no caret was captured', () => {
    const adapter = makeAdapter();
    const editor = makeComboboxEditor('<p>hold</p>');
    stubInnerFocus(editor);
    select(editor.querySelector('p')!.firstChild!, 4);
    const target = adapter.captureTarget(editor) as InsertionTarget;

    expect(adapter.previewText(target, ' alpha').ok).toBe(true);
    editor.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', shiftKey: true, bubbles: true }));
    // The browser applied Shift+Enter as a SOFT break: a <br> right after
    // the delivered words. The selection is unreadable from here on.
    const firstP = editor.querySelector('p')!;
    firstP.appendChild(document.createElement('br'));
    stubClearedSelection();

    // New words spoken after the break belong on the line the user moved
    // to — inferred from the break itself (no caret was ever captured).
    expect(adapter.previewText(target, ' alpha beta').ok).toBe(true);
    expect(firstP.textContent).toBe('hold alpha beta');
    expect(firstP.lastChild!.textContent).toBe(' beta');
    expect(firstP.querySelector('br')).not.toBeNull();
    adapter.dispose();
  });

  it('keeps repeated deltas in order when a rebuild detaches the appended continuation', () => {
    const adapter = makeAdapter();
    const editor = makeComboboxEditor('<p>hold</p>');
    stubInnerFocus(editor);
    select(editor.querySelector('p')!.firstChild!, 4);
    const target = adapter.captureTarget(editor) as InsertionTarget;

    expect(adapter.previewText(target, ' alpha').ok).toBe(true);
    // Enter with NO break in the DOM and NO readable caret: the first
    // continuation delta falls back to appending at the delivered prefix.
    editor.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', shiftKey: true, bubbles: true }));
    stubClearedSelection();
    expect(adapter.previewText(target, ' alpha beta').ok).toBe(true);
    expect(editor.querySelector('p')!.textContent).toBe('hold alpha beta');

    // Keep rebuilds the paragraph: the tracked continuation node is
    // replaced by fresh text with the same content.
    const firstP = editor.querySelector('p')!;
    firstP.replaceChildren(document.createTextNode('hold alpha beta'));

    // The next delta must keep growing the utterance IN ORDER, not insert
    // before the words already appended.
    expect(adapter.previewText(target, ' alpha beta gamma').ok).toBe(true);
    expect(editor.querySelector('p')!.textContent).toBe('hold alpha beta gamma');
    adapter.dispose();
  });

  it('moves the resume anchor after a committed continuation for the next utterance', () => {
    const adapter = makeAdapter();
    const editor = makeComboboxEditor('<p>hold</p>');
    stubInnerFocus(editor);
    select(editor.querySelector('p')!.firstChild!, 4);
    const target = adapter.captureTarget(editor) as InsertionTarget;

    expect(adapter.previewText(target, ' alpha').ok).toBe(true);
    // A NON-Enter gesture releases the preview without any line break, so
    // placement falls to the delivered region (no caret inference).
    editor.dispatchEvent(new KeyboardEvent('keydown', { key: '.', bubbles: true }));
    stubClearedSelection();
    expect(adapter.insertText(target, ' alpha beta').ok).toBe(true);
    expect(editor.querySelector('p')!.textContent).toBe('hold alpha beta');

    // The NEXT utterance continues AFTER the committed words — at the
    // updated anchor — not at the pre-continuation position.
    expect(adapter.previewText(target, ' gamma').ok).toBe(true);
    expect(editor.querySelector('p')!.textContent).toBe('hold alpha beta gamma');
    adapter.dispose();
  });

  it('preserves the delivered-prefix record across a same-root recapture (language cycle)', () => {
    const adapter = makeAdapter();
    const editor = makeComboboxEditor('<p>hold</p>');
    stubInnerFocus(editor);
    select(editor.querySelector('p')!.firstChild!, 4);
    const target = adapter.captureTarget(editor) as InsertionTarget;

    expect(adapter.previewText(target, ' alpha').ok).toBe(true);
    // A non-Enter gesture hands the interim words to the user mid-utterance.
    editor.dispatchEvent(new KeyboardEvent('keydown', { key: '.', bubbles: true }));
    // The user cycles the language: handleCycleLanguage restarts the session
    // and RE-CAPTURES the same editor. The delivered prefix must survive —
    // wiping it used to make the final re-type the whole phrase.
    const recaptured = adapter.captureTarget(editor) as Extract<InsertionTarget, { type: 'contenteditable' }>;

    expect(adapter.insertText(recaptured, ' alpha beta').ok).toBe(true);
    expect(editor.querySelector('p')!.textContent).toBe('hold alpha beta');
    adapter.dispose();
  });

  it('keeps the continuation on the new line when Keep rebuilds a soft-broken paragraph', () => {
    const adapter = makeAdapter();
    const editor = makeComboboxEditor('<p>hold</p>');
    stubInnerFocus(editor);
    select(editor.querySelector('p')!.firstChild!, 4);
    const target = adapter.captureTarget(editor) as Extract<InsertionTarget, { type: 'contenteditable' }>;

    expect(adapter.previewText(target, ' alpha').ok).toBe(true);
    // The user presses Shift+Enter at the caret: a soft break is appended
    // and the caret moves right after it (an element position).
    editor.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', shiftKey: true, bubbles: true }));
    const firstP = editor.querySelector('p')!;
    firstP.appendChild(document.createElement('br'));
    select(firstP, firstP.childNodes.length);
    document.dispatchEvent(new Event('selectionchange'));

    // Keep's rebuild replaces the paragraph but preserves the text AND the
    // soft break; the selection is gone.
    const rebuilt = document.createElement('p');
    rebuilt.appendChild(document.createTextNode('hold alpha'));
    rebuilt.appendChild(document.createElement('br'));
    firstP.replaceWith(rebuilt);
    stubClearedSelection();

    // Words spoken after the break belong on the NEW line — the block-
    // anchored caret record must resolve to after the <br>, not to the end
    // of the previous line (same text offset, other side of the break).
    expect(adapter.previewText(target, ' alpha beta').ok).toBe(true);
    expect(rebuilt.childNodes[1]).toBeInstanceOf(HTMLBRElement);
    expect(rebuilt.lastChild!.textContent).toBe(' beta');
    expect(rebuilt.textContent).toBe('hold alpha beta');
    adapter.dispose();
  });

  it('resolves the caret after consecutive soft breaks to the right line when Keep rebuilds', () => {
    const adapter = makeAdapter();
    const editor = makeComboboxEditor('<p>hold</p>');
    stubInnerFocus(editor);
    select(editor.querySelector('p')!.firstChild!, 4);
    const target = adapter.captureTarget(editor) as Extract<InsertionTarget, { type: 'contenteditable' }>;

    expect(adapter.previewText(target, ' alpha').ok).toBe(true);
    editor.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', shiftKey: true, bubbles: true }));
    const firstP = editor.querySelector('p')!;
    firstP.appendChild(document.createElement('br'));
    select(firstP, firstP.childNodes.length);
    document.dispatchEvent(new Event('selectionchange'));

    // A SECOND Shift+Enter right away: another <br>, caret behind it. Both
    // breaks share one text offset — only the ordinal tells them apart.
    editor.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', shiftKey: true, bubbles: true }));
    firstP.appendChild(document.createElement('br'));
    select(firstP, firstP.childNodes.length);
    document.dispatchEvent(new Event('selectionchange'));

    const rebuilt = document.createElement('p');
    rebuilt.appendChild(document.createTextNode('hold alpha'));
    rebuilt.appendChild(document.createElement('br'));
    rebuilt.appendChild(document.createElement('br'));
    firstP.replaceWith(rebuilt);
    stubClearedSelection();

    expect(adapter.previewText(target, ' alpha beta').ok).toBe(true);
    expect(rebuilt.childNodes[2]).toBeInstanceOf(HTMLBRElement);
    expect(rebuilt.lastChild!.textContent).toBe(' beta');
    adapter.dispose();
  });

  it('never records a rebuild-echo caret that surfaces after a write (reported: caret jumps to the first character)', () => {
    const adapter = makeAdapter();
    const editor = makeComboboxEditor(
      '<p><span data-ri="0">I want to add this text where you can</span></p>'
    );
    stubInnerFocus(editor);
    const text = editor.querySelector('span')!.firstChild as Text;
    select(text, 37);
    const target = adapter.captureTarget(editor) as Extract<InsertionTarget, { type: 'contenteditable' }>;

    // Shift+Enter; Keep clears the selection before the new caret is
    // readable, so nothing is captured, and the write goes out blind at the
    // tracked anchor.
    editor.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', shiftKey: true, bubbles: true }));
    stubClearedSelection();
    expect(adapter.insertText(target, ' or').ok).toBe(true);
    expect(editor.textContent).toBe('I want to add this text where you can or');

    // Keep's rebuild remaps the selection to the FIRST CHARACTER of the
    // note — the echo of our own write. The still-open capture window must
    // not record it as the user's caret.
    const rebuiltSpan = document.createElement('span');
    rebuiltSpan.setAttribute('data-ri', '0');
    rebuiltSpan.textContent = 'I want to add this text where you can or';
    editor.querySelector('span')!.replaceWith(rebuiltSpan);
    vi.restoreAllMocks();
    stubInnerFocus(editor);
    select(rebuiltSpan.firstChild as Text, 0);
    document.dispatchEvent(new Event('selectionchange'));
    stubClearedSelection();

    // The next words continue after the committed text — they must not
    // splice in before the "I" and drag the visible caret there with them.
    expect(adapter.previewText(target, ' you can').ok).toBe(true);
    expect(editor.textContent).toBe('I want to add this text where you can or you can');
    adapter.dispose();
  });

  it('rejects a delayed old-line text caret after Enter', () => {
    const adapter = makeAdapter();
    const editor = makeComboboxEditor('<p>line</p>');
    stubInnerFocus(editor);
    select(editor.querySelector('p')!.firstChild!, 4);
    const target = adapter.captureTarget(editor) as Extract<InsertionTarget, { type: 'contenteditable' }>;

    expect(adapter.insertText(target, ' tail').ok).toBe(true);
    target.range.setStart(editor, 0);
    target.range.collapse(true);
    editor.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', shiftKey: true, bubbles: true }));

    const oldText = editor.querySelector('p')!.firstChild as Text;
    select(oldText, 1);
    document.dispatchEvent(new Event('selectionchange'));

    const second = document.createElement('p');
    editor.appendChild(second);
    select(second, 0);
    document.dispatchEvent(new Event('selectionchange'));
    stubClearedSelection();

    expect(adapter.previewText(target, ' next').ok).toBe(true);
    expect(Array.from(editor.querySelectorAll('p'), (p) => p.textContent)).toEqual(['line tail', 'next']);
    adapter.dispose();
  });

  it('never adopts a stale start-of-text selection when a gesture did not move the caret', () => {
    const adapter = makeAdapter();
    const editor = makeComboboxEditor('<p><span data-ri="0">abc</span></p>');
    stubInnerFocus(editor);
    const spanText = editor.querySelector('span')!.firstChild as Text;
    select(spanText, 3);
    const target = adapter.captureTarget(editor) as Extract<InsertionTarget, { type: 'contenteditable' }>;

    expect(adapter.insertText(target, ' one').ok).toBe(true);
    expect(editor.textContent).toBe('abc one');

    // A rebuild leaves the live selection parked at the very START of the
    // text (our write's echo). The user then presses a key that does not
    // move the caret (e.g. Shift) — the gesture opens the capture window,
    // but no caret move ever follows it.
    select(spanText, 0);
    editor.dispatchEvent(new KeyboardEvent('keydown', { key: 'Shift', bubbles: true }));

    expect(adapter.insertText(target, ' X').ok).toBe(true);
    expect(editor.textContent).toBe('abc one X');
    adapter.dispose();
  });

  it('places later deltas at the caret the user moved to with a SECOND manual Enter', () => {
    const adapter = makeAdapter();
    const editor = makeComboboxEditor('<p>hold</p>');
    stubInnerFocus(editor);
    select(editor.querySelector('p')!.firstChild!, 4);
    const target = adapter.captureTarget(editor) as Extract<InsertionTarget, { type: 'contenteditable' }>;

    expect(adapter.previewText(target, ' alpha').ok).toBe(true);
    // First Shift+Enter: the continuation lands on the new line.
    editor.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', shiftKey: true, bubbles: true }));
    const firstP = editor.querySelector('p')!;
    firstP.appendChild(document.createElement('br'));
    select(firstP, firstP.childNodes.length);
    document.dispatchEvent(new Event('selectionchange'));
    stubClearedSelection();
    expect(adapter.previewText(target, ' alpha beta').ok).toBe(true);
    expect(firstP.lastChild!.textContent).toBe(' beta');

    // The user breaks AGAIN from the end of the continuation: another <br>,
    // the caret behind it.
    vi.restoreAllMocks();
    stubInnerFocus(editor);
    editor.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', shiftKey: true, bubbles: true }));
    firstP.appendChild(document.createElement('br'));
    select(firstP, firstP.childNodes.length);
    document.dispatchEvent(new Event('selectionchange'));
    stubClearedSelection();

    // The next delta belongs behind the SECOND break — not rewritten onto
    // the line the first continuation lives on.
    expect(adapter.previewText(target, ' alpha beta gamma').ok).toBe(true);
    expect(firstP.lastChild!.textContent).toBe(' gamma');
    adapter.dispose();
  });

  it('keeps continuation-node text the user typed when the utterance grows', () => {
    const adapter = makeAdapter();
    const editor = makeComboboxEditor('<p>hold</p>');
    stubInnerFocus(editor);
    select(editor.querySelector('p')!.firstChild!, 4);
    const target = adapter.captureTarget(editor) as Extract<InsertionTarget, { type: 'contenteditable' }>;

    expect(adapter.previewText(target, ' alpha').ok).toBe(true);
    editor.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', shiftKey: true, bubbles: true }));
    const p = editor.querySelector('p')!;
    p.appendChild(document.createElement('br'));
    select(p, p.childNodes.length);
    document.dispatchEvent(new Event('selectionchange'));
    stubClearedSelection();
    expect(adapter.previewText(target, ' alpha beta').ok).toBe(true);
    expect(p.lastChild!.textContent).toBe(' beta');

    target.previewNode!.appendData(' EXTRA');
    expect(adapter.previewText(target, ' alpha beta gamma').ok).toBe(true);
    expect(p.textContent).toContain('EXTRA');
    expect(p.textContent).toContain('gamma');
    adapter.dispose();
  });

  it('places the first continuation after the SECOND soft break when the second capture misses', () => {
    const adapter = makeAdapter();
    const editor = makeComboboxEditor('<p>hold</p>');
    stubInnerFocus(editor);
    select(editor.querySelector('p')!.firstChild!, 4);
    const target = adapter.captureTarget(editor) as InsertionTarget;

    expect(adapter.previewText(target, ' alpha').ok).toBe(true);
    editor.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', shiftKey: true, bubbles: true }));
    const p = editor.querySelector('p')!;
    p.appendChild(document.createElement('br'));
    select(p, p.childNodes.length);
    document.dispatchEvent(new Event('selectionchange'));

    vi.restoreAllMocks();
    stubInnerFocus(editor);
    stubClearedSelection();
    editor.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', shiftKey: true, bubbles: true }));
    p.appendChild(document.createElement('br'));
    document.dispatchEvent(new Event('selectionchange'));

    expect(adapter.previewText(target, ' alpha beta').ok).toBe(true);
    expect(p.lastChild!.textContent).toBe(' beta');
    adapter.dispose();
  });

  it('re-anchors a rebuild-remapped tracked range to the dictation anchor before writing', () => {
    const adapter = makeAdapter();
    const editor = makeComboboxEditor('<p><span data-ri="0">I want to add this text where you can</span></p>');
    stubInnerFocus(editor);
    select(editor.querySelector('span')!.firstChild!, 37);
    const target = adapter.captureTarget(editor) as Extract<InsertionTarget, { type: 'contenteditable' }>;

    expect(adapter.insertText(target, ' or').ok).toBe(true);
    expect(editor.textContent).toBe('I want to add this text where you can or');

    // Keep's rebuild replaces the span. The browser silently remaps the
    // tracked range to the start of the paragraph — it still "belongs to"
    // the editor, so validate() passes and nothing re-anchors it.
    const rebuiltSpan = document.createElement('span');
    rebuiltSpan.setAttribute('data-ri', '0');
    rebuiltSpan.textContent = 'I want to add this text where you can or';
    editor.querySelector('span')!.replaceWith(rebuiltSpan);
    stubClearedSelection();

    // No gesture, no captured caret: the remembered anchor owns placement.
    // The remapped range must not splice the next words before the "I".
    expect(adapter.previewText(target, ' you can').ok).toBe(true);
    expect(adapter.insertText(target, ' you can').ok).toBe(true);
    expect(editor.textContent).toBe('I want to add this text where you can or you can');
    adapter.dispose();
  });

  it('never deletes captured selection contents on a plain contenteditable Keep root', () => {
    const adapter = makeAdapter();
    const editor = makeEditor('<p>alpha</p><p>beta</p>');
    const span = document.createRange();
    span.setStart(editor.querySelectorAll('p')[0]!.firstChild!, 5);
    span.setEnd(editor.querySelectorAll('p')[1]!.firstChild!, 4);
    stubSelection(span, editor);

    const target = adapter.captureTarget(editor) as Extract<InsertionTarget, { type: 'contenteditable' }>;
    expect(target.range.collapsed).toBe(true);

    expect(adapter.insertText(target, ' gamma').ok).toBe(true);
    expect(Array.from(editor.querySelectorAll('p'), (p) => p.textContent)).toEqual([
      'alpha gamma',
      'beta',
    ]);
    adapter.dispose();
  });

  it('keeps both committed languages when a rebuild remaps the selection across the whole note (reported flow: EN commit → switch to FA → manual Shift+Enter)', () => {
    const adapter = makeAdapter();
    const editor = makeComboboxEditor('<p>Hello</p>');
    stubInnerFocus(editor);
    select(editor.querySelector('p')!.firstChild!, 5);
    const target = adapter.captureTarget(editor) as InsertionTarget;

    // English committed first (a completed utterance, no live preview).
    expect(adapter.insertText(target, ' world').ok).toBe(true);
    expect(editor.querySelector('p')!.textContent).toBe('Hello world');

    // The user switches dictation to Farsi mid-session: handleCycleLanguage
    // re-captures the SAME note, which must not discard in-flight state
    // (userGestureSequence, captured caret, delivered prefix).
    const recaptured = adapter.captureTarget(editor) as InsertionTarget;
    expect(adapter.previewText(recaptured, ' فارسی').ok).toBe(true);
    expect(editor.querySelector('p')!.textContent).toBe('Hello world فارسی');

    // Manual Shift+Enter; Keep's rebuild remaps the selection into a
    // NON-COLLAPSED range spanning the WHOLE note (both languages) — the
    // reported "everything I wrote is deleted" vector. The next write must
    // NOT adopt that span and wipe it.
    editor.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', shiftKey: true, bubbles: true }));
    const newLine = document.createElement('p');
    editor.appendChild(newLine);
    const span = document.createRange();
    span.setStart(editor, 0);
    span.setEnd(editor, editor.childNodes.length);
    stubSelection(span);

    // The next Farsi result: neither committed language may be deleted, and
    // the new words belong on the line the user broke to.
    expect(adapter.previewText(recaptured, ' بعدی').ok).toBe(true);
    expect(Array.from(editor.querySelectorAll('p'), (p) => p.textContent)).toEqual(['Hello world فارسی', 'بعدی']);
    adapter.dispose();
  });
});

describe('Keep reported flow: EN commit → language cycle → FA → manual Shift+Enter', () => {
  function select(node: Node, offset: number): void {
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(collapsedRangeIn(node, offset));
  }

  function stubInnerFocus(editor: HTMLElement): void {
    const inner = document.createElement('div');
    editor.appendChild(inner);
    Object.defineProperty(document, 'activeElement', { value: inner, configurable: true });
  }

  /** Keep rewrites each canonical <p>'s children on every input sync. */
  function keepRebuildsOnInput(editor: HTMLElement): void {
    editor.addEventListener('input', () => {
      for (const p of Array.from(editor.querySelectorAll('p'))) {
        p.replaceChildren(document.createTextNode(p.textContent ?? ''));
      }
    });
  }

  /** Keep's rebuild remapping the selection across the whole note. */
  function remapSelectionAcrossNote(editor: HTMLElement): void {
    const span = document.createRange();
    span.setStart(editor, 0);
    span.setEnd(editor, editor.childNodes.length);
    stubSelection(span);
  }

  beforeEach(() => {
    host = 'keep.google.com';
  });

  it('keeps committed FA text across a manual Shift+Enter and keeps dictating', () => {
    const adapter = makeAdapter();
    const editor = makeComboboxEditor('<p></p>');
    stubInnerFocus(editor);
    keepRebuildsOnInput(editor);
    select(editor.querySelector('p')!, 0);
    const target = adapter.captureTarget(editor) as InsertionTarget;

    expect(adapter.insertText(target, 'Hello world').ok).toBe(true);

    const recaptured = adapter.captureTarget(editor) as InsertionTarget;
    expect(adapter.previewText(recaptured, ' فارسی').ok).toBe(true);
    expect(adapter.insertText(recaptured, ' فارسی').ok).toBe(true);
    expect(editor.querySelector('p')!.textContent).toBe('Hello world فارسی');

    editor.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', shiftKey: true, bubbles: true }));
    const second = document.createElement('p');
    editor.appendChild(second);
    select(second, 0);
    document.dispatchEvent(new Event('selectionchange'));
    remapSelectionAcrossNote(editor);

    expect(adapter.previewText(recaptured, ' بعدی').ok).toBe(true);
    expect(adapter.insertText(recaptured, ' بعدی').ok).toBe(true);

    expect(Array.from(editor.querySelectorAll('p'), (p) => p.textContent)).toEqual([
      'Hello world فارسی',
      'بعدی',
    ]);
    adapter.dispose();
  });

  it('keeps a LIVE FA preview across a manual Shift+Enter and keeps dictating', () => {
    const adapter = makeAdapter();
    const editor = makeComboboxEditor('<p></p>');
    stubInnerFocus(editor);
    keepRebuildsOnInput(editor);
    select(editor.querySelector('p')!, 0);
    const target = adapter.captureTarget(editor) as InsertionTarget;

    expect(adapter.insertText(target, 'Hello world').ok).toBe(true);
    const recaptured = adapter.captureTarget(editor) as InsertionTarget;
    expect(adapter.previewText(recaptured, ' فارسی').ok).toBe(true);
    expect(editor.querySelector('p')!.textContent).toBe('Hello world فارسی');

    editor.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', shiftKey: true, bubbles: true }));
    const second = document.createElement('p');
    editor.appendChild(second);
    select(second, 0);
    document.dispatchEvent(new Event('selectionchange'));
    remapSelectionAcrossNote(editor);

    expect(adapter.previewText(recaptured, ' بعدی').ok).toBe(true);
    expect(adapter.insertText(recaptured, ' بعدی').ok).toBe(true);

    expect(Array.from(editor.querySelectorAll('p'), (p) => p.textContent)).toEqual([
      'Hello world فارسی',
      'بعدی',
    ]);
    adapter.dispose();
  });

  it('keeps earlier lines when a SECOND manual Shift+Enter follows more dictation', () => {
    const adapter = makeAdapter();
    const editor = makeComboboxEditor('<p></p>');
    stubInnerFocus(editor);
    keepRebuildsOnInput(editor);
    select(editor.querySelector('p')!, 0);
    const target = adapter.captureTarget(editor) as InsertionTarget;

    expect(adapter.insertText(target, 'Hello world').ok).toBe(true);
    const recaptured = adapter.captureTarget(editor) as InsertionTarget;
    expect(adapter.insertText(recaptured, ' فارسی').ok).toBe(true);

    // First manual break.
    editor.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', shiftKey: true, bubbles: true }));
    const second = document.createElement('p');
    editor.appendChild(second);
    select(second, 0);
    document.dispatchEvent(new Event('selectionchange'));
    remapSelectionAcrossNote(editor);

    expect(adapter.insertText(recaptured, ' بعدی').ok).toBe(true);
    const linesAfterFirst = Array.from(editor.querySelectorAll('p'), (p) => p.textContent);
    expect(linesAfterFirst).toEqual(['Hello world فارسی', 'بعدی']);

    // Second manual break from the end of the new line, then dictate again.
    editor.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', shiftKey: true, bubbles: true }));
    const third = document.createElement('p');
    editor.appendChild(third);
    select(third, 0);
    document.dispatchEvent(new Event('selectionchange'));
    remapSelectionAcrossNote(editor);

    expect(adapter.insertText(recaptured, ' سوم').ok).toBe(true);
    expect(Array.from(editor.querySelectorAll('p'), (p) => p.textContent)).toEqual([
      'Hello world فارسی',
      'بعدی',
      'سوم',
    ]);
    adapter.dispose();
  });
  it('REPRO: multi-utterance session with manual Enters keeps the transcript intact', () => {
    const adapter = makeAdapter();
    const editor = makeComboboxEditor('<p></p>');
    stubInnerFocus(editor);
    keepRebuildsOnInput(editor);
    select(editor.querySelector('p')!, 0);
    const target = adapter.captureTarget(editor) as InsertionTarget;

    const dump = (label: string): void => {
      const lines = Array.from(editor.querySelectorAll('p'), (p) => p.textContent);
      // eslint-disable-next-line no-console
      console.log(label, JSON.stringify(lines));
    };

    expect(adapter.insertText(target, 'we want to add some text to this section').ok).toBe(true);
    dump('after EN-ish commit');

    editor.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', shiftKey: true, bubbles: true }));
    const line2 = document.createElement('p');
    editor.appendChild(line2);
    select(line2, 0);
    document.dispatchEvent(new Event('selectionchange'));
    dump('after Enter 1');

    expect(adapter.previewText(target, 'no').ok).toBe(true);
    expect(adapter.insertText(target, 'no').ok).toBe(true);
    dump('after "no"');

    editor.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', shiftKey: true, bubbles: true }));
    const line3 = document.createElement('p');
    editor.appendChild(line3);
    select(line3, 0);
    document.dispatchEvent(new Event('selectionchange'));
    dump('after Enter 2');

    // One long utterance that grows while the user keeps pressing Enter.
    expect(adapter.previewText(target, 'I want to press enter again').ok).toBe(true);
    dump('interim 1');
    editor.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', shiftKey: true, bubbles: true }));
    const line4 = document.createElement('p');
    editor.appendChild(line4);
    select(line4, 0);
    document.dispatchEvent(new Event('selectionchange'));
    dump('after Enter 3');

    expect(adapter.previewText(target, 'I want to press enter again this is the second test').ok).toBe(true);
    dump('interim 2');
    expect(adapter.insertText(target, 'I want to press enter again this is the second test I will press enter in this section').ok).toBe(true);
    dump('final');

    const lines = Array.from(editor.querySelectorAll('p'), (p) => p.textContent);
    expect(lines).toEqual([
      'we want to add some text to this section',
      'no',
      'I want to press enter again',
      'this is the second test I will press enter in this section',
    ]);
    adapter.dispose();
  });
});

describe('isKeepHost', () => {
  it('matches keep.google.com and subdomains only', () => {
    expect(isKeepHost('keep.google.com')).toBe(true);
    expect(isKeepHost('x.keep.google.com')).toBe(true);
    expect(isKeepHost('notkeep.google.com')).toBe(false);
    expect(isKeepHost('keep.google.com.evil.example')).toBe(false);
    expect(isKeepHost('mail.google.com')).toBe(false);
  });
});

describe('GoogleKeepAdapter.canHandle', () => {
  it('handles contenteditable editors on Keep and nowhere else', () => {
    host = 'keep.google.com';
    const adapter = makeAdapter();
    const editor = makeEditor('Hello');
    expect(adapter.canHandle(editor)).toBe(true);

    host = 'mail.google.com';
    expect(makeAdapter().canHandle(editor)).toBe(false);
  });
});

describe('GoogleKeepAdapter — Docs-style combobox note body', () => {
  it('handles the combobox editor root on Keep and nowhere else', () => {
    host = 'keep.google.com';
    const adapter = makeAdapter();
    const editor = makeComboboxEditor('<p dir="rtl"><span data-ri="0">سلام دنیا</span></p>');
    expect(adapter.canHandle(editor)).toBe(true);

    host = 'mail.google.com';
    expect(makeAdapter().canHandle(editor)).toBe(false);
  });

  it('handles focus landing on a paragraph inside the combobox', () => {
    host = 'keep.google.com';
    const adapter = makeAdapter();
    const editor = makeComboboxEditor('<p dir="rtl"><span data-ri="0">متن</span></p>');
    const span = editor.querySelector('span') as HTMLElement;
    expect(adapter.canHandle(span)).toBe(true);
    expect((adapter.captureTarget(span) as InsertionTarget).element).toBe(editor);
  });

  it('captures and inserts into the note body and fires the input event', () => {
    host = 'keep.google.com';
    const adapter = makeAdapter();
    const editor = makeComboboxEditor('<p dir="rtl"><span data-ri="0">سلام</span></p>');
    const inputListener = vi.fn();
    editor.addEventListener('input', inputListener);
    stubSelection(null); // focus without caret → caret lands at end of content
    const target = adapter.captureTarget(editor) as InsertionTarget;

    expect(target.type).toBe('contenteditable');
    expect(target.element).toBe(editor);
    expect(adapter.insertText(target, ' دنیا')).toEqual({ ok: true });
    expect(editor.textContent).toBe('سلام دنیا');
    expect(inputListener).toHaveBeenCalled();
    const event = inputListener.mock.calls[0][0] as Event;
    expect(event.bubbles).toBe(true);
  });

  it('still captures when Keep flips the combobox to contenteditable=true', () => {
    host = 'keep.google.com';
    const adapter = makeAdapter();
    const editor = makeComboboxEditor('<p><span data-ri="0">x</span></p>');
    editor.setAttribute('contenteditable', 'true');
    stubSelection(null);
    const target = adapter.captureTarget(editor) as InsertionTarget;
    expect(target.element).toBe(editor);
  });
});

describe('GoogleKeepAdapter.insertText — Keep input sync', () => {
  it('dispatches a bubbling input event so Keep saves the note', () => {
    host = 'keep.google.com';
    const adapter = makeAdapter();
    const editor = makeEditor('Hello');
    const inputListener = vi.fn();
    editor.addEventListener('input', inputListener);
    stubSelection(collapsedRangeIn(editor.firstChild as Text, 5));
    const target = adapter.captureTarget(editor) as InsertionTarget;

    expect(adapter.insertText(target, ' world')).toEqual({ ok: true });
    expect(editor.textContent).toBe('Hello world');
    expect(inputListener).toHaveBeenCalled();
    const event = inputListener.mock.calls[0][0] as Event;
    expect(event.bubbles).toBe(true);
  });

  it('also fires input events for live previews', () => {
    host = 'keep.google.com';
    const adapter = makeAdapter();
    const editor = makeEditor('');
    const inputListener = vi.fn();
    editor.addEventListener('input', inputListener);
    stubSelection(null);
    const target = adapter.captureTarget(editor) as InsertionTarget;

    expect(adapter.previewText(target, ' spoken')).toEqual({ ok: true });
    expect(editor.textContent).toBe('spoken'); // leading engine space trimmed at very start
    expect(inputListener).toHaveBeenCalled();
  });
});

describe('GoogleKeepAdapter.validateTarget — DOM re-normalization', () => {
  it('re-anchors a stale range to the live caret inside the same editor', () => {
    host = 'keep.google.com';
    const adapter = makeAdapter();
    const editor = makeEditor('fresh content');
    stubSelection(collapsedRangeIn(editor.firstChild as Text, 5), editor);
    const target = adapter.captureTarget(editor) as InsertionTarget;

    // Keep rewrote the editor's children — the captured range now points at
    // a detached node.
    (target as { range: Range }).range = detachedRange();
    // ...but the user's caret is live inside the editor (stub above).

    expect(adapter.validateTarget(target)).toEqual({ ok: true });
  });

  it('re-anchors to end of content when the editor survived but the selection is gone', () => {
    host = 'keep.google.com';
    const adapter = makeAdapter();
    const editor = makeEditor('fresh content');
    stubSelection(null, editor); // Keep clears the DOM selection on re-render; focus stays
    const target = adapter.captureTarget(editor) as InsertionTarget;
    (target as { range: Range }).range = detachedRange();

    expect(adapter.validateTarget(target)).toEqual({ ok: true });

    // The rescued range must insert at the end of the live content.
    stubSelection(collapsedRangeIn(editor.lastChild as Text, (editor.lastChild as Text).length));
    expect(adapter.insertText(target, ' more')).toEqual({ ok: true });
    expect(editor.textContent).toBe('fresh content more');
  });

  it('rescues the combobox body even when focus moved elsewhere (Keep owns focus)', () => {
    host = 'keep.google.com';
    const adapter = makeAdapter();
    const editor = makeComboboxEditor('<p dir="rtl"><span data-ri="0">اول</span></p>');
    stubSelection(detachedRange(), document.body); // focus left, selection orphaned
    const target = adapter.captureTarget(editor) as InsertionTarget;
    (target as { range: Range }).range = detachedRange();

    expect(adapter.validateTarget(target)).toEqual({ ok: true });
  });

  it('still fails when the editor itself was removed', () => {
    host = 'keep.google.com';
    const adapter = makeAdapter();
    const editor = makeEditor('abc');
    stubSelection(null);
    const target = adapter.captureTarget(editor) as InsertionTarget;
    editor.remove();
    expect(adapter.validateTarget(target).ok).toBe(false);
  });

  it('still fails when the focused element is a DIFFERENT editor (stale capture)', () => {
    host = 'keep.google.com';
    const adapter = makeAdapter();
    const editor = makeEditor('abc');
    stubSelection(collapsedRangeIn(editor.firstChild as Text, 1), editor);
    const target = adapter.captureTarget(editor) as InsertionTarget;
    (target as { range: Range }).range = detachedRange();

    // Focus moved to another editor entirely, whose caret is live there —
    // the captured target is stale and must NOT be rescued into this one.
    const other = document.createElement('div');
    other.setAttribute('contenteditable', 'true');
    other.textContent = 'other';
    document.body.appendChild(other);
    stubSelection(collapsedRangeIn(other.firstChild as Text, 0), other);

    expect(adapter.validateTarget(target).ok).toBe(false);
  });
});

describe('GoogleKeepAdapter — canonical <p> anchoring (Keep renderer drops bare children)', () => {
  it('inserts into the last <p> after Keep re-renders, not as a bare combobox child', () => {
    host = 'keep.google.com';
    const adapter = makeAdapter();
    const editor = makeComboboxEditor('<p dir="ltr"><span data-ri="0">first word</span></p>');
    // Keep's combobox body owns focus/selection; after its input sync it
    // drops the DOM selection. Our validate() re-anchors to end-of-content,
    // the generic adapter would land at (editor, childCount) — a bare-child
    // position the renderer drops on the next sync.
    stubSelection(detachedRange(), document.body);
    const target = adapter.captureTarget(editor) as InsertionTarget;
    (target as { range: Range }).range = detachedRange();

    expect(adapter.validateTarget(target)).toEqual({ ok: true });
    expect(adapter.insertText(target, ' second word')).toEqual({ ok: true });

    const bareTextNodes = [...editor.childNodes].filter(
      (n) => n.nodeType === Node.TEXT_NODE && (n.textContent ?? '').trim() !== ''
    );
    expect(bareTextNodes).toHaveLength(0);
    expect(editor.querySelector('p')?.textContent).toBe('first word second word');
  });

  it('keeps dictating into a Keep checklist item across repeated re-renders', () => {
    host = 'keep.google.com';
    const adapter = makeAdapter();
    const editor = makeComboboxEditor('<p><span data-ri="0">one</span></p>');
    stubSelection(null, document.body);
    const target = adapter.captureTarget(editor) as InsertionTarget;

    for (const word of [' two', ' three', ' four']) {
      // Simulate Keep's renderer rewriting the item after each input sync:
      // it rebuilds <p><span data-ri> from its model and detaches anything
      // outside that structure (which is what used to drop every word
      // after the first).
      const p = editor.querySelector('p') as HTMLParagraphElement;
      const span = document.createElement('span');
      span.setAttribute('data-ri', '0');
      span.textContent = p.textContent ?? '';
      p.replaceChildren(span);
      (target as { range: Range }).range = detachedRange();
      expect(adapter.validateTarget(target).ok).toBe(true);
      expect(adapter.insertText(target, word).ok).toBe(true);
    }

    expect(editor.querySelector('p')?.textContent).toBe('one two three four');
    const bareTextNodes = [...editor.childNodes].filter(
      (n) => n.nodeType === Node.TEXT_NODE && (n.textContent ?? '').trim() !== ''
    );
    expect(bareTextNodes).toHaveLength(0);
  });

  it('follows the user to a new checklist item when Enter creates one mid-session', () => {
    host = 'keep.google.com';
    const adapter = makeAdapter();

    function selectIn(node: Node, offset: number): void {
      const selection = window.getSelection()!;
      selection.removeAllRanges();
      selection.addRange(collapsedRangeIn(node, offset));
    }

    const item1 = makeComboboxEditor('<p><span data-ri="0">first</span></p>');
    Object.defineProperty(document, 'activeElement', { value: item1, configurable: true });
    selectIn(item1.querySelector('p span')!.firstChild!, 5);
    const target = adapter.captureTarget(item1) as InsertionTarget;

    try {
      expect(adapter.previewText(target, ' word').ok).toBe(true);
      expect(item1.querySelector('p')!.textContent).toBe('first word');

      // The user presses Enter: Keep creates a NEW checklist item — its own
      // combobox root — and focus/selection move into it. The capture only ran
      // at session start and still points at item 1.
      item1.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      const item2 = makeComboboxEditor('<p><br data-ri="0"></p>');
      Object.defineProperty(document, 'activeElement', { value: item2, configurable: true });
      selectIn(item2.querySelector('p')!, 0);

      expect(adapter.insertText(target, ' word two').ok).toBe(true);
      // The new words land in the item the user moved to; the item they left
      // keeps exactly what was already spoken into it (no second copy, no
      // splicing into the old item's text).
      expect(item1.querySelector('p')!.textContent).toBe('first word');
      expect(item2.querySelector('p')!.textContent).toBe('word two');
    } finally {
      adapter.dispose();
    }
  });

  it('live preview + final commit land inside the canonical <p> and replace in place', () => {
    host = 'keep.google.com';
    const adapter = makeAdapter();
    const editor = makeComboboxEditor('<p><span data-ri="0">hello</span></p>');
    stubSelection(null, document.body);
    const target = adapter.captureTarget(editor) as InsertionTarget;

    expect(adapter.previewText(target, ' wor').ok).toBe(true);
    // Keep absorbs the preview into its canonical span and rebuilds <p>
    // from its model, detaching our preview text node.
    const p = editor.querySelector('p') as HTMLParagraphElement;
    const span = document.createElement('span');
    span.setAttribute('data-ri', '0');
    span.textContent = p.textContent ?? '';
    p.replaceChildren(span);
    (target as { range: Range }).range = detachedRange();
    expect(adapter.insertText(target, ' world').ok).toBe(true);
    // The final must reclaim the previewed words and replace them inside the
    // canonical span — not append a bare duplicate sibling of <p>.
    expect(editor.textContent).toBe('hello world');
    expect(span.textContent).toBe('hello world');
  });

  it('multi-paragraph note body: anchors the insertion to the end of the LAST <p>', () => {
    host = 'keep.google.com';
    const adapter = makeAdapter();
    const editor = makeComboboxEditor(
      '<p dir="ltr"><span data-ri="0">first</span></p>' +
        '<p dir="ltr"><span data-ri="0">second</span></p>'
    );
    stubSelection(detachedRange(), document.body);
    const target = adapter.captureTarget(editor) as InsertionTarget;
    (target as { range: Range }).range = detachedRange();

    expect(adapter.insertText(target, ' more').ok).toBe(true);
    const paragraphs = editor.querySelectorAll('p');
    expect(paragraphs[0]!.textContent).toBe('first');
    expect(paragraphs[1]!.textContent).toBe('second more');
  });
});

describe('GoogleKeepAdapter — checklist note dump shape', () => {
  it('captures each checklist item as its own root; a caret inside an item promotes to THAT item', () => {
    host = 'keep.google.com';
    const adapter = makeAdapter();
    try {
      const [first, second, third] = makeChecklistNote(['first', 'second', 'third']);

      for (const item of [first, second, third]) {
        expect(adapter.canHandle(item)).toBe(true);
        expect(item.getAttribute('aria-label')).toBe('list item');
        stubSelection(collapsedRangeIn(item.querySelector('p span')!.firstChild!, 0));
        const target = adapter.captureTarget(item) as InsertionTarget;
        expect(target.element).toBe(item);
      }

      stubSelection(collapsedRangeIn(second.querySelector('p span')!.firstChild!, 0));
      const fromParagraph = adapter.captureTarget(second.querySelector('p')!) as InsertionTarget;
      expect(fromParagraph.element).toBe(second);
      expect(fromParagraph.element).not.toBe(first);
      expect(fromParagraph.element).not.toBe(third);
    } finally {
      adapter.dispose();
    }
  });
});

describe('GoogleKeepAdapter — caret tracking across synchronous rebuilds', () => {
  let lastAddedRange: Range | null = null;

  /**
   * Mimics Keep's renderer faithfully: on every input sync it rebuilds the
   * canonical <p><span data-ri> structure, REPLACING whole <p> elements
   * (which detaches tracked ranges and makes the browser collapse the live
   * selection to the editor start — the exact conditions that used to drag
   * the caret to the beginning and mix up text).
   */
  function keepRebuild(editor: HTMLElement): void {
    const paras = [...editor.querySelectorAll(':scope > p')];
    const texts = (paras.length > 0 ? paras : [editor]).map((p) => p.textContent ?? '');
    editor.replaceChildren();
    texts.forEach((t, i) => {
      const p = document.createElement('p');
      const span = document.createElement('span');
      span.setAttribute('data-ri', String(i));
      span.textContent = t;
      p.appendChild(span);
      editor.appendChild(p);
    });
  }

  function stubSelectionRecording(range: Range | null, active: Element | null = null): void {
    const selection = {
      rangeCount: range ? 1 : 0,
      getRangeAt: () => range,
      removeAllRanges: vi.fn(),
      addRange: (r: Range) => {
        lastAddedRange = r;
      },
    };
    vi.spyOn(window, 'getSelection').mockReturnValue(selection as unknown as Selection);
    if (active) {
      Object.defineProperty(document, 'activeElement', { value: active, configurable: true });
    }
  }

  /** Text offset of the last asserted caret, or null when detached. */
  function caretOffset(editor: HTMLElement): number | null {
    if (!lastAddedRange || !editor.contains(lastAddedRange.startContainer)) return null;
    const probe = document.createRange();
    probe.selectNodeContents(editor);
    probe.setEnd(lastAddedRange.startContainer, lastAddedRange.startOffset);
    return probe.toString().length;
  }

  beforeEach(() => {
    lastAddedRange = null;
  });

  it('keeps the caret mid-text with repeated words (no jump to start, no duplication)', () => {
    host = 'keep.google.com';
    const adapter = makeAdapter();
    const editor = makeComboboxEditor('<p><span data-ri="0">hello world, hello</span></p>');
    editor.addEventListener('input', () => keepRebuild(editor));
    const text = (editor.querySelector('span') as HTMLElement).firstChild as Text;
    // Caret after the FIRST "hello " (offset 6), editor focused.
    stubSelectionRecording(collapsedRangeIn(text, 6), editor);
    const target = adapter.captureTarget(editor) as InsertionTarget;

    expect(adapter.previewText(target, 'beautiful').ok).toBe(true);
    expect(editor.textContent).toBe('hello beautifulworld, hello');

    // Keep rebuilt synchronously; the browser collapsed the live selection
    // to the editor start — the adapter must NOT adopt that as the caret.
    stubSelectionRecording(collapsedRangeIn(editor, 0), editor);
    expect(adapter.previewText(target, 'beautiful day').ok).toBe(true);
    expect(editor.textContent).toBe('hello beautiful dayworld, hello');

    stubSelectionRecording(collapsedRangeIn(editor, 0), editor);
    expect(adapter.insertText(target, 'beautiful day').ok).toBe(true);
    // Each word exactly once, existing text untouched and in order.
    expect(editor.textContent).toBe('hello beautiful dayworld, hello');
    // Caret sits right after the commit — not at the start.
    expect(caretOffset(editor)).toBe('hello beautiful day'.length);
  });

  it('appends a growing multiline note in order, one copy of each word', () => {
    host = 'keep.google.com';
    const adapter = makeAdapter();
    const editor = makeComboboxEditor(
      '<p><span data-ri="0">first</span></p><p><span data-ri="1">second</span></p>'
    );
    editor.addEventListener('input', () => keepRebuild(editor));
    const lastSpan = editor.querySelectorAll('span')[1] as HTMLElement;
    const lastText = lastSpan.firstChild as Text;
    stubSelectionRecording(collapsedRangeIn(lastText, lastText.length), editor);
    const target = adapter.captureTarget(editor) as InsertionTarget;

    for (const [preview, final] of [
      [' third', 'third'],
      [' fourth', 'fourth'],
      [' fifth', 'fifth'],
    ] as const) {
      expect(adapter.previewText(target, preview).ok).toBe(true);
      stubSelectionRecording(collapsedRangeIn(editor, 0), editor);
      expect(adapter.insertText(target, final).ok).toBe(true);
      stubSelectionRecording(collapsedRangeIn(editor, 0), editor);
    }

    const paras = editor.querySelectorAll('p');
    expect(paras[0]!.textContent).toBe('first');
    expect(paras[1]!.textContent).toBe('secondthirdfourthfifth');
    expect(caretOffset(editor)).toBe(editor.textContent!.length);
  });

  it('handles an embedded newline and keeps dictating after it', () => {
    host = 'keep.google.com';
    const adapter = makeAdapter();
    const editor = makeComboboxEditor('<p><span data-ri="0">start</span></p>');
    editor.addEventListener('input', () => keepRebuild(editor));
    stubSelectionRecording(null, document.body);
    const target = adapter.captureTarget(editor) as InsertionTarget;

    expect(adapter.insertText(target, ' one\ntwo').ok).toBe(true);
    stubSelectionRecording(collapsedRangeIn(editor, 0), editor);
    expect(adapter.insertText(target, ' three').ok).toBe(true);

    const flat = editor.textContent ?? '';
    for (const w of ['start', 'one', 'two', 'three']) {
      expect(flat).toContain(w);
    }
    expect((flat.match(/three/g) ?? []).length).toBe(1);
    expect(caretOffset(editor)).toBe(flat.length);
  });

  it('rejects a degenerate element-edge live caret instead of inserting at the start', () => {
    host = 'keep.google.com';
    const adapter = makeAdapter();
    const editor = makeComboboxEditor('<p><span data-ri="0">abc</span></p>');
    stubSelectionRecording(null, document.body);
    const target = adapter.captureTarget(editor) as InsertionTarget;
    (target as { range: Range }).range = detachedRange();

    // Browser reset the orphaned selection to (firstP, 0) — element-edge,
    // collapsed. Adopting it would splice new speech at the very start.
    const firstP = editor.querySelector('p') as HTMLParagraphElement;
    stubSelectionRecording(collapsedRangeIn(firstP, 0), editor);
    expect(adapter.validateTarget(target).ok).toBe(true);
    expect(adapter.insertText(target, ' X').ok).toBe(true);
    expect(editor.textContent).toBe('abc X');
  });

  it('does not refocus a combobox that already holds focus (focus resets Keep caret)', () => {
    host = 'keep.google.com';
    const adapter = makeAdapter();
    const editor = makeComboboxEditor('<p><span data-ri="0">abc</span></p>');
    stubSelectionRecording(null, editor);
    const target = adapter.captureTarget(editor) as InsertionTarget;
    const focusSpy = vi.spyOn(editor, 'focus');

    expect(adapter.insertText(target, ' def').ok).toBe(true);
    expect(focusSpy).not.toHaveBeenCalled();
    expect(editor.textContent).toBe('abc def');
  });

  it('refocuses the combobox when focus genuinely left the editor', () => {
    host = 'keep.google.com';
    const adapter = makeAdapter();
    const editor = makeComboboxEditor('<p><span data-ri="0">abc</span></p>');
    stubSelectionRecording(null, document.body);
    const target = adapter.captureTarget(editor) as InsertionTarget;
    const focusSpy = vi.spyOn(editor, 'focus');

    expect(adapter.insertText(target, ' def').ok).toBe(true);
    expect(focusSpy).toHaveBeenCalled();
    expect(editor.textContent).toBe('abc def');
  });
});

describe('GoogleKeepAdapter — live caret intent (gesture gate)', () => {
  let lastAddedRange: Range | null = null;
  let addRangeCalls = 0;

  function keepRebuild(editor: HTMLElement): void {
    const paras = [...editor.querySelectorAll(':scope > p')];
    const texts = (paras.length > 0 ? paras : [editor]).map((p) => p.textContent ?? '');
    editor.replaceChildren();
    texts.forEach((t, i) => {
      const p = document.createElement('p');
      const span = document.createElement('span');
      span.setAttribute('data-ri', String(i));
      span.textContent = t;
      p.appendChild(span);
      editor.appendChild(p);
    });
  }

  function stubSelectionRecording(range: Range | null, active: Element | null = null): void {
    const selection = {
      rangeCount: range ? 1 : 0,
      getRangeAt: () => range,
      removeAllRanges: vi.fn(),
      addRange: (r: Range) => {
        lastAddedRange = r;
        addRangeCalls += 1;
      },
    };
    vi.spyOn(window, 'getSelection').mockReturnValue(selection as unknown as Selection);
    if (active) {
      Object.defineProperty(document, 'activeElement', { value: active, configurable: true });
    }
  }

  /** Simulate a genuine user press inside the editor (reaches our document listener). */
  function dispatchUserGesture(node: Node): void {
    node.dispatchEvent(new Event('pointerdown', { bubbles: true }));
  }

  /** Text offset of the last asserted caret, or null when detached. */
  function caretOffset(editor: HTMLElement): number | null {
    if (!lastAddedRange || !editor.contains(lastAddedRange.startContainer)) return null;
    const probe = document.createRange();
    probe.selectNodeContents(editor);
    probe.setEnd(lastAddedRange.startContainer, lastAddedRange.startOffset);
    return probe.toString().length;
  }

  beforeEach(() => {
    lastAddedRange = null;
    addRangeCalls = 0;
  });

  it('ignores a stale previous-line caret when the user made no gesture', () => {
    // Acceptance scenario: continuous dictation at the end of a multiline
    // note. Keep drags the live selection back to the previous line between
    // phrases; with no user gesture since our last write that position is
    // Keep echoing our edits back — adopting it would splice new speech into
    // the previous line and concatenate it with existing text.
    host = 'keep.google.com';
    const adapter = makeAdapter();
    const editor = makeComboboxEditor(
      '<p><span data-ri="0">line one here</span></p><p><span data-ri="1">second line here</span></p>'
    );
    editor.addEventListener('input', () => keepRebuild(editor));
    stubSelectionRecording(null, document.body);
    const target = adapter.captureTarget(editor) as InsertionTarget;

    expect(adapter.insertText(target, ' one').ok).toBe(true);
    expect(editor.textContent).toBe('line one heresecond line here one');

    // Keep "restored" the live caret to the previous line (text node!).
    // No user gesture happened — this must NOT be adopted.
    const firstSpan = editor.querySelectorAll('span')[0] as HTMLElement;
    const firstText = firstSpan.firstChild as Text;
    stubSelectionRecording(collapsedRangeIn(firstText, 5), editor);
    expect(adapter.insertText(target, ' two').ok).toBe(true);

    const paras = editor.querySelectorAll('p');
    expect(paras[0]!.textContent).toBe('line one here');
    expect(paras[1]!.textContent).toBe('second line here one two');
    // Each word exactly once.
    expect((editor.textContent!.match(/two/g) ?? []).length).toBe(1);
  });

  it('adopts the live caret after a genuine user gesture', () => {
    host = 'keep.google.com';
    const adapter = makeAdapter();
    const editor = makeComboboxEditor('<p><span data-ri="0">abc</span></p>');
    stubSelectionRecording(null, document.body);
    const target = adapter.captureTarget(editor) as InsertionTarget;

    // Deterministic clock: the mock is installed BEFORE any op so the
    // gesture can be strictly newer than the last write.
    let now = 1000;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    expect(adapter.insertText(target, ' one').ok).toBe(true);
    expect(editor.textContent).toBe('abc one');

    now = 1001;
    const span = editor.querySelector('span') as HTMLElement;
    dispatchUserGesture(span);

    // User deliberately placed the caret after "a".
    const text = span.firstChild as Text;
    stubSelectionRecording(collapsedRangeIn(text, 1), editor);
    expect(adapter.insertText(target, ' X').ok).toBe(true);
    expect(editor.textContent).toBe('a Xbc one');

    // Afterwards, with no newer gesture, a stale caret is ignored again:
    // dictation continues at the TRACKED mid-text position (offset 3, right
    // after the just-inserted " X") — not at the stale live position 0.
    const freshSpan = editor.querySelector('span') as HTMLElement;
    const freshText = freshSpan.firstChild as Text;
    stubSelectionRecording(collapsedRangeIn(freshText, 0), editor);
    expect(adapter.insertText(target, ' tail').ok).toBe(true);
    expect(editor.textContent).toBe('a X tailbc one');
  });

  it('deferred re-assert repairs the visible caret after an async stale restore', () => {
    host = 'keep.google.com';
    const adapter = makeAdapter();
    const editor = makeComboboxEditor('<p><span data-ri="0">abc</span></p>');
    editor.addEventListener('input', () => keepRebuild(editor));
    stubSelectionRecording(null, editor);
    const target = adapter.captureTarget(editor) as InsertionTarget;

    vi.useFakeTimers();
    try {
      expect(adapter.previewText(target, ' def').ok).toBe(true);
      expect(editor.textContent).toBe('abc def');

      // Fresh stub: observe only what the deferred pass does. The guarded
      // chain asserts the same offset several times (macrotask, frames,
      // trailing pass) — each call re-adds the range.
      addRangeCalls = 0;
      stubSelectionRecording(null, editor);
      addRangeCalls = 0;
      vi.runAllTimers();

      expect(addRangeCalls).toBeGreaterThanOrEqual(1);
      expect(caretOffset(editor)).toBe('abc def'.length);
    } finally {
      vi.useRealTimers();
    }
  });

  it('deferred re-assert aborts when the user takes over or focus leaves', () => {
    host = 'keep.google.com';
    const adapter = makeAdapter();
    const editor = makeComboboxEditor('<p><span data-ri="0">abc</span></p>');
    editor.addEventListener('input', () => keepRebuild(editor));
    stubSelectionRecording(null, editor);
    const target = adapter.captureTarget(editor) as InsertionTarget;

    vi.useFakeTimers();
    try {
      let now = 1000;
      vi.spyOn(Date, 'now').mockImplementation(() => now);
      expect(adapter.previewText(target, ' def').ok).toBe(true);

      // Case 1: user gesture after scheduling wins — never yank their caret.
      addRangeCalls = 0;
      stubSelectionRecording(null, editor);
      addRangeCalls = 0;
      now = 1001;
      dispatchUserGesture(editor.querySelector('span') as HTMLElement);
      vi.runAllTimers();
      expect(addRangeCalls).toBe(0);

      // Case 2: focus left the editor — nothing to fix here.
      expect(adapter.previewText(target, ' def!').ok).toBe(true);
      addRangeCalls = 0;
      stubSelectionRecording(null, document.body);
      addRangeCalls = 0;
      vi.runAllTimers();
      expect(addRangeCalls).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('repairs the caret when a rebuild drags it away AFTER the macrotask pass', () => {
    host = 'keep.google.com';
    const adapter = makeAdapter();
    const editor = makeComboboxEditor('<p><span data-ri="0">abc</span></p>');
    stubSelectionRecording(null, editor);
    const target = adapter.captureTarget(editor) as InsertionTarget;

    vi.useFakeTimers();
    try {
      expect(adapter.previewText(target, ' def').ok).toBe(true);
      expect(editor.textContent).toBe('abc def');

      // Fresh stub: observe only what happens from here on.
      addRangeCalls = 0;
      stubSelectionRecording(null, editor);
      addRangeCalls = 0;

      // Keep's reconciliation is asynchronous: the rebuild lands AFTER the
      // macrotask pass has already run, and the browser collapses the fresh
      // selection to the editor start (the real-world "caret jumps to the
      // front" observation). The re-assert chain must repair it afterwards —
      // the old single setTimeout(0) pass fired before the rebuild and could
      // not.
      setTimeout(() => {
        keepRebuild(editor);
        stubSelectionRecording(collapsedRangeIn(editor, 0), editor);
      }, 10);
      vi.runAllTimers();

      expect(caretOffset(editor)).toBe('abc def'.length);
    } finally {
      vi.useRealTimers();
    }
  });

  it('continues at the original caret when a sync drops the previewed words', () => {
    host = 'keep.google.com';
    const adapter = makeAdapter();
    const editor = makeComboboxEditor('<p><span data-ri="0">hello world</span></p>');
    const text = (editor.querySelector('span') as HTMLElement).firstChild as Text;
    stubSelectionRecording(collapsedRangeIn(text, 5), editor); // hello| world
    const target = adapter.captureTarget(editor) as InsertionTarget;

    expect(adapter.previewText(target, ' beautiful').ok).toBe(true);
    expect(editor.textContent).toBe('hello beautiful world');

    // Keep's model sync DROPPED the previewed words: the rebuilt editor is
    // back to its original text and our preview node is gone.
    const p = document.createElement('p');
    const span = document.createElement('span');
    span.setAttribute('data-ri', '0');
    span.textContent = 'hello world';
    p.appendChild(span);
    editor.replaceChildren(p);
    stubSelectionRecording(collapsedRangeIn(editor, 0), editor);

    // The next interim must continue at the original caret (offset 6) — the
    // old fallback anchored to the end of content and appended behind ALL
    // the text ("hello world sunny"), which read as the caret jumping behind
    // the existing text before Keep's rebuild dragged it to the front.
    expect(adapter.previewText(target, ' sunny').ok).toBe(true);
    expect(editor.textContent).toBe('hello sunny world');
  });
});

describe('GoogleKeepAdapter — event-driven caret guardian (late rebuilds)', () => {
  let lastAddedRange: Range | null = null;
  let addRangeCalls = 0;

  function keepRebuild(editor: HTMLElement): void {
    const paras = [...editor.querySelectorAll(':scope > p')];
    const texts = (paras.length > 0 ? paras : [editor]).map((p) => p.textContent ?? '');
    editor.replaceChildren();
    texts.forEach((t, i) => {
      const p = document.createElement('p');
      const span = document.createElement('span');
      span.setAttribute('data-ri', String(i));
      span.textContent = t;
      p.appendChild(span);
      editor.appendChild(p);
    });
  }

  /**
   * Stateful Selection mock: addRange/getRangeAt behave like a real browser
   * (what getRangeAt returns is the last range that was set), so the
   * guardian's offset-equality check and self-termination can be observed.
   * Returns a handle to set the "browser" selection directly (simulating the
   * remap a rebuild causes) without counting as an adapter write.
   */
  function stubLiveSelection(
    initial: Range | null,
    active: Element | null = null
  ): { set: (range: Range | null) => void } {
    let liveRange: Range | null = initial;
    const selection = {
      get rangeCount(): number {
        return liveRange ? 1 : 0;
      },
      getRangeAt: () => {
        if (!liveRange) throw new Error('no range selected');
        return liveRange;
      },
      removeAllRanges: () => {
        liveRange = null;
      },
      addRange: (r: Range) => {
        liveRange = r;
        lastAddedRange = r;
        addRangeCalls += 1;
      },
    };
    vi.spyOn(window, 'getSelection').mockReturnValue(selection as unknown as Selection);
    if (active) {
      Object.defineProperty(document, 'activeElement', { value: active, configurable: true });
    }
    return {
      set: (range: Range | null) => {
        liveRange = range;
      },
    };
  }

  /** Keep's rebuild remaps the caret to the editor start (measured artifact). */
  function remapToStart(
    editor: HTMLElement,
    live: { set: (range: Range | null) => void }
  ): void {
    keepRebuild(editor);
    live.set(collapsedRangeIn(editor, 0));
  }

  /** Text offset of the last asserted caret, or null when detached. */
  function caretOffset(editor: HTMLElement): number | null {
    if (!lastAddedRange || !editor.contains(lastAddedRange.startContainer)) return null;
    const probe = document.createRange();
    probe.selectNodeContents(editor);
    probe.setEnd(lastAddedRange.startContainer, lastAddedRange.startOffset);
    return probe.toString().length;
  }

  function dispatchSelectionChange(): void {
    document.dispatchEvent(new Event('selectionchange'));
  }

  beforeEach(() => {
    lastAddedRange = null;
    addRangeCalls = 0;
  });

  it('repairs a caret that a debounced rebuild drags to the start AFTER the re-assert chain ends', () => {
    // Regression for the reported bug: Keep's debounced model sync fires
    // ~350ms after a write; the fixed chain's last pass runs at 250ms, so
    // the caret used to rest at the start until the next phrase (~1s later).
    host = 'keep.google.com';
    const adapter = makeAdapter();
    const editor = makeComboboxEditor('<p><span data-ri="0">abc</span></p>');
    const spanText = (editor.querySelector('span') as HTMLElement).firstChild as Text;
    const live = stubLiveSelection(collapsedRangeIn(spanText, 3), editor);
    const target = adapter.captureTarget(editor) as InsertionTarget;

    vi.useFakeTimers();
    try {
      expect(adapter.previewText(target, ' def').ok).toBe(true);
      expect(editor.textContent).toBe('abc def');
      vi.advanceTimersByTime(300); // the whole fixed chain has run by now

      addRangeCalls = 0;
      remapToStart(editor, live);
      dispatchSelectionChange();

      expect(addRangeCalls).toBe(1);
      expect(caretOffset(editor)).toBe('abc def'.length);
    } finally {
      vi.useRealTimers();
    }
  });

  it('repairs the remap via the rebuild observer before any selectionchange dispatch', async () => {
    host = 'keep.google.com';
    const adapter = makeAdapter();
    const editor = makeComboboxEditor('<p><span data-ri="0">abc</span></p>');
    const spanText = (editor.querySelector('span') as HTMLElement).firstChild as Text;
    const live = stubLiveSelection(collapsedRangeIn(spanText, 3), editor);
    const target = adapter.captureTarget(editor) as InsertionTarget;

    vi.useFakeTimers();
    try {
      expect(adapter.previewText(target, ' def').ok).toBe(true);
      vi.advanceTimersByTime(300);

      addRangeCalls = 0;
      remapToStart(editor, live);
      // No selectionchange: the MutationObserver armed on the editor must
      // repair in the microtask after the rebuild — before the browser can
      // paint the wrong caret position.
      await vi.advanceTimersByTimeAsync(0);

      expect(addRangeCalls).toBe(1);
      expect(caretOffset(editor)).toBe('abc def'.length);
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps the caret at the dictation position across synchronous + late reconciliations', async () => {
    host = 'keep.google.com';
    const adapter = makeAdapter();
    const editor = makeComboboxEditor('<p><span data-ri="0">abc</span></p>');
    const spanText = (editor.querySelector('span') as HTMLElement).firstChild as Text;
    const live = stubLiveSelection(collapsedRangeIn(spanText, 3), editor);
    const target = adapter.captureTarget(editor) as InsertionTarget;

    vi.useFakeTimers();
    try {
      // Every input sync rebuilds and the browser collapses the selection to
      // the editor start — the full real-world sequence per write.
      editor.addEventListener('input', () => remapToStart(editor, live));

      expect(adapter.previewText(target, ' def').ok).toBe(true);
      expect(caretOffset(editor)).toBe('abc def'.length);
      vi.advanceTimersByTime(300); // the fixed re-assert chain is done

      // Keep's DEBOUNCED model sync: rebuild + caret collapse past the
      // chain's last pass. Only the guardian can repair this.
      addRangeCalls = 0;
      setTimeout(() => remapToStart(editor, live), 50);
      await vi.advanceTimersByTimeAsync(50);

      expect(addRangeCalls).toBe(1); // the guardian repaired it
      expect(caretOffset(editor)).toBe('abc def'.length);
    } finally {
      vi.useRealTimers();
    }
  });

  it('multi-line note: repairs the caret to the end of the last line after a start remap', () => {
    host = 'keep.google.com';
    const adapter = makeAdapter();
    const editor = makeComboboxEditor(
      '<p><span data-ri="0">first line here</span></p><p><span data-ri="1">second line here</span></p>'
    );
    const secondText = (editor.querySelectorAll('span')[1] as HTMLElement).firstChild as Text;
    const live = stubLiveSelection(collapsedRangeIn(secondText, secondText.length), editor);
    const target = adapter.captureTarget(editor) as InsertionTarget;

    vi.useFakeTimers();
    try {
      expect(adapter.previewText(target, ' more').ok).toBe(true);
      vi.advanceTimersByTime(300);

      addRangeCalls = 0;
      remapToStart(editor, live);
      dispatchSelectionChange();

      expect(caretOffset(editor)).toBe((editor.textContent ?? '').length);
    } finally {
      vi.useRealTimers();
    }
  });

  it('guards the caret after a continuation write lands on the user\'s new line (reported: cursor to start after Enter)', async () => {
    host = 'keep.google.com';
    const adapter = makeAdapter();
    const editor = makeComboboxEditor('<p><span data-ri="0">hello</span></p>');
    editor.addEventListener('input', () => keepRebuild(editor));
    const text = (editor.querySelector('span') as HTMLElement).firstChild as Text;
    const live = stubLiveSelection(collapsedRangeIn(text, text.length), editor);
    const target = adapter.captureTarget(editor) as InsertionTarget;

    vi.useFakeTimers();
    try {
      // A pending preview is live when the user breaks the line manually.
      expect(adapter.previewText(target, ' world').ok).toBe(true);
      expect(editor.textContent).toBe('hello world');

      editor.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      // The browser applied the Enter: a new empty paragraph, caret at its
      // start, exposed to the adapter via the following selectionchange.
      const second = document.createElement('p');
      const secondSpan = document.createElement('span');
      secondSpan.setAttribute('data-ri', '1');
      second.appendChild(secondSpan);
      editor.appendChild(second);
      live.set(collapsedRangeIn(second, 0));
      dispatchSelectionChange();

      // The utterance keeps growing past the break: the delta lands on the
      // line the user moved to.
      expect(adapter.insertText(target, ' world peace').ok).toBe(true);
      expect(Array.from(editor.querySelectorAll('p'), (p) => p.textContent)).toEqual([
        'hello world',
        'peace',
      ]);

      // Keep's debounced rebuild remaps the caret to the editor start. The
      // continuation write must carry the same repair machinery a plain
      // write has — otherwise the caret rests at the start until the next
      // phrase (the reported "cursor moves to the start of the line").
      addRangeCalls = 0;
      setTimeout(() => remapToStart(editor, live), 50);
      await vi.advanceTimersByTimeAsync(50);

      expect(addRangeCalls).toBeGreaterThanOrEqual(1);
      expect(caretOffset(editor)).toBe((editor.textContent ?? '').length);
    } finally {
      vi.useRealTimers();
    }
  });

  it('restores a selection that Keep cleared during a re-render while guarded', () => {
    host = 'keep.google.com';
    const adapter = makeAdapter();
    const editor = makeComboboxEditor('<p><span data-ri="0">abc</span></p>');
    const spanText = (editor.querySelector('span') as HTMLElement).firstChild as Text;
    const live = stubLiveSelection(collapsedRangeIn(spanText, 3), editor);
    const target = adapter.captureTarget(editor) as InsertionTarget;

    vi.useFakeTimers();
    try {
      expect(adapter.previewText(target, ' def').ok).toBe(true);
      vi.advanceTimersByTime(300);

      addRangeCalls = 0;
      live.set(null); // Keep cleared the DOM selection
      dispatchSelectionChange();

      expect(addRangeCalls).toBe(1);
      expect(caretOffset(editor)).toBe('abc def'.length);
    } finally {
      vi.useRealTimers();
    }
  });

  it('self-terminates: a selection already at the asserted offset triggers no repair', () => {
    host = 'keep.google.com';
    const adapter = makeAdapter();
    const editor = makeComboboxEditor('<p><span data-ri="0">abc</span></p>');
    const spanText = (editor.querySelector('span') as HTMLElement).firstChild as Text;
    const live = stubLiveSelection(collapsedRangeIn(spanText, 3), editor);
    const target = adapter.captureTarget(editor) as InsertionTarget;

    vi.useFakeTimers();
    try {
      expect(adapter.previewText(target, ' def').ok).toBe(true);
      vi.advanceTimersByTime(300);

      addRangeCalls = 0;
      remapToStart(editor, live);
      dispatchSelectionChange();
      expect(addRangeCalls).toBe(1);

      // The repaired selection is now what getRangeAt returns (stateful
      // mock) — further events must not re-add the range.
      dispatchSelectionChange();
      dispatchSelectionChange();
      expect(addRangeCalls).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('disarms on a user gesture and never yanks the caret back', () => {
    host = 'keep.google.com';
    const adapter = makeAdapter();
    const editor = makeComboboxEditor('<p><span data-ri="0">abc</span></p>');
    const spanText = (editor.querySelector('span') as HTMLElement).firstChild as Text;
    const live = stubLiveSelection(collapsedRangeIn(spanText, 3), editor);
    const target = adapter.captureTarget(editor) as InsertionTarget;

    vi.useFakeTimers();
    try {
      expect(adapter.previewText(target, ' def').ok).toBe(true);
      vi.advanceTimersByTime(300);
      addRangeCalls = 0;

      // The user takes over after our write — the guardian must stand down
      // for this and every later event.
      vi.advanceTimersByTime(1);
      (editor.querySelector('span') as HTMLElement).dispatchEvent(
        new Event('pointerdown', { bubbles: true })
      );
      remapToStart(editor, live);
      dispatchSelectionChange();
      vi.advanceTimersByTime(100);
      dispatchSelectionChange();

      expect(addRangeCalls).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('preserves the caret through a long speech pause', () => {
    host = 'keep.google.com';
    const adapter = makeAdapter();
    const editor = makeComboboxEditor('<p><span data-ri="0">abc</span></p>');
    const spanText = (editor.querySelector('span') as HTMLElement).firstChild as Text;
    const live = stubLiveSelection(collapsedRangeIn(spanText, 3), editor);
    const target = adapter.captureTarget(editor) as InsertionTarget;

    vi.useFakeTimers();
    try {
      expect(adapter.previewText(target, ' def').ok).toBe(true);
      vi.advanceTimersByTime(300);
      addRangeCalls = 0;

      vi.advanceTimersByTime(2001);
      remapToStart(editor, live);
      dispatchSelectionChange();
      vi.advanceTimersByTime(100);
      dispatchSelectionChange();

      expect(addRangeCalls).toBe(1);
      expect(caretOffset(editor)).toBe('abc def'.length);
      if (target.type === 'contenteditable') {
        expect(target.range.startContainer).toBe(lastAddedRange!.startContainer);
        expect(target.range.startOffset).toBe(lastAddedRange!.startOffset);
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it('resetPreview (session end) stops later caret repairs without clearing preview text', () => {
    host = 'keep.google.com';
    const adapter = makeAdapter();
    const editor = makeComboboxEditor('<p><span data-ri="0">abc</span></p>');
    const spanText = (editor.querySelector('span') as HTMLElement).firstChild as Text;
    const live = stubLiveSelection(collapsedRangeIn(spanText, 3), editor);
    const target = adapter.captureTarget(editor) as InsertionTarget;

    vi.useFakeTimers();
    try {
      expect(adapter.previewText(target, ' def').ok).toBe(true);
      vi.advanceTimersByTime(300);

      adapter.resetPreview(target); // RecognitionManager calls this on stop
      addRangeCalls = 0;
      remapToStart(editor, live);
      dispatchSelectionChange();
      vi.advanceTimersByTime(100);
      dispatchSelectionChange();

      expect(addRangeCalls).toBe(0);
      expect(editor.textContent).toBe('abc def'); // text kept as real text
    } finally {
      vi.useRealTimers();
      adapter.dispose();
    }
  });

  it('never touches a genuine non-collapsed selection inside the editor', () => {
    host = 'keep.google.com';
    const adapter = makeAdapter();
    const editor = makeComboboxEditor('<p><span data-ri="0">abcdef</span></p>');
    const spanText = (editor.querySelector('span') as HTMLElement).firstChild as Text;
    const live = stubLiveSelection(collapsedRangeIn(spanText, 3), editor);
    const target = adapter.captureTarget(editor) as InsertionTarget;

    vi.useFakeTimers();
    try {
      expect(adapter.previewText(target, ' def').ok).toBe(true);
      vi.advanceTimersByTime(300);
      addRangeCalls = 0;

      const selected = document.createRange();
      selected.setStart(spanText, 0);
      selected.setEnd(spanText, 3);
      live.set(selected);
      dispatchSelectionChange();

      expect(addRangeCalls).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not repair when focus has left the guarded editor', () => {
    host = 'keep.google.com';
    const adapter = makeAdapter();
    const editor = makeComboboxEditor('<p><span data-ri="0">abc</span></p>');
    const spanText = (editor.querySelector('span') as HTMLElement).firstChild as Text;
    const live = stubLiveSelection(collapsedRangeIn(spanText, 3), editor);
    const target = adapter.captureTarget(editor) as InsertionTarget;

    vi.useFakeTimers();
    try {
      expect(adapter.previewText(target, ' def').ok).toBe(true);
      vi.advanceTimersByTime(300);
      addRangeCalls = 0;

      // Focus moved elsewhere without a tracked gesture (Keep moves focus
      // during re-renders): stand down, and do not steal the other field.
      const other = document.createElement('input');
      document.body.appendChild(other);
      Object.defineProperty(document, 'activeElement', { value: other, configurable: true });
      remapToStart(editor, live);
      dispatchSelectionChange();

      expect(addRangeCalls).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('GoogleKeepAdapter — reported Enter/Shift+Enter line-split and text-loss regressions', () => {
  function select(node: Node, offset: number): void {
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(collapsedRangeIn(node, offset));
  }

  /** Focus sits on Keep's inner layer, never on the combobox root itself. */
  function stubInnerFocus(editor: HTMLElement): HTMLElement {
    const inner = document.createElement('div');
    editor.appendChild(inner);
    Object.defineProperty(document, 'activeElement', { value: inner, configurable: true });
    return inner;
  }

  /**
   * Stateful Selection mock: getRangeAt returns whatever the "browser" holds,
   * and addRange updates it — so both the adapter's caret writes and Keep's
   * remaps are observable through one coherent selection for the whole test.
   */
  function stubBrowserSelection(initial: Range | null, active: Element): { set: (r: Range | null) => void } {
    let liveRange: Range | null = initial;
    const selection = {
      get rangeCount(): number {
        return liveRange ? 1 : 0;
      },
      getRangeAt: () => {
        if (!liveRange) throw new Error('no range selected');
        return liveRange;
      },
      removeAllRanges: () => {
        liveRange = null;
      },
      addRange: (range: Range) => {
        liveRange = range;
      },
    };
    vi.spyOn(window, 'getSelection').mockReturnValue(selection as unknown as Selection);
    Object.defineProperty(document, 'activeElement', { value: active, configurable: true });
    return {
      set: (range) => {
        liveRange = range;
      },
    };
  }

  function lines(editor: HTMLElement): string[] {
    return Array.from(editor.querySelectorAll('p'), (p) => p.textContent ?? '');
  }

  /**
   * Keep rebuilds every canonical <p> on each input sync, replacing the text
   * nodes our tracked ranges point into and remapping the browser selection
   * to the start of the editor — the field conditions that detach Ranges.
   */
  function keepRebuildsOnInput(editor: HTMLElement, live: { set: (r: Range | null) => void }): void {
    editor.addEventListener('input', () => {
      for (const p of Array.from(editor.querySelectorAll('p'))) {
        p.replaceChildren(document.createTextNode(p.textContent ?? ''));
      }
      live.set(collapsedRangeIn(editor, 0));
    });
  }

  /** The user presses Enter; Keep creates the next line and moves the caret. */
  function pressEnter(editor: HTMLElement, live: { set: (r: Range | null) => void }): HTMLParagraphElement {
    editor.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    const created = document.createElement('p');
    editor.appendChild(created);
    live.set(collapsedRangeIn(created, 0));
    document.dispatchEvent(new Event('selectionchange'));
    return created;
  }

  beforeEach(() => {
    host = 'keep.google.com';
  });

  it('REPRO: Enter never splits the previous line — the whole note stays intact', async () => {
    // The reported symptom: pressing Enter split the CURRENT line, leaving its
    // first characters behind and moving the rest to the next line. That is
    // what happens when a write places words on the line the user just left
    // and then asserts the visible caret there: the user's next Enter cuts
    // that line at the dictation offset. Every line must keep exactly the
    // text it had, and each word must appear once, in the order spoken.
    vi.useFakeTimers();
    const adapter = makeAdapter();
    const editor = makeComboboxEditor('<p></p>');
    const inner = stubInnerFocus(editor);
    const firstLine = editor.querySelector('p')!;
    const live = stubBrowserSelection(collapsedRangeIn(firstLine, 0), inner);
    keepRebuildsOnInput(editor, live);
    const target = adapter.captureTarget(editor) as InsertionTarget;

    try {
      const spoken = [
        { text: 'we want to add some text', break: true },
        { text: 'to this section of the note', break: true },
        { text: 'and keep going after the break', break: false },
      ] as const;
      // The engine pads every utterance with a space, which the adapter drops
      // at the start of a line — so the expected note is built by hand rather
      // than by concatenating raw transcript text.
      const expected: string[] = [''];
      for (const { text, break: pressBreak } of spoken) {
        // Preview the utterance, then commit the final for it.
        expect(adapter.previewText(target, ` ${text.slice(0, 6)}`).ok).toBe(true);
        expect(adapter.insertText(target, ` ${text}`).ok).toBe(true);
        const last = expected.length - 1;
        expected[last] = expected[last] === '' ? text.trimStart() : expected[last] + ` ${text}`;
        // Nothing was split, moved, duplicated or dropped: the note is exactly
        // what was spoken, one copy per word, in order.
        expect(lines(editor)).toEqual(expected);
        vi.advanceTimersByTime(300);
        if (pressBreak) {
          pressEnter(editor, live);
          // The new line starts empty: the break consumed no text.
          expect(lines(editor)[lines(editor).length - 1]).toBe('');
          expected.push('');
        }
      }

      expect(lines(editor)).toEqual([
        'we want to add some text',
        'to this section of the note',
        'and keep going after the break',
      ]);
    } finally {
      adapter.dispose();
      vi.useRealTimers();
    }
  });

  /** A selection mock that records asserted carets but exposes no live range. */
  function stubClearedSelection(): { lastAdded: Range | null } {
    const record = { lastAdded: null as Range | null };
    vi.spyOn(window, 'getSelection').mockReturnValue({
      rangeCount: 0,
      getRangeAt: () => {
        throw new Error('no ranges');
      },
      removeAllRanges: vi.fn(),
      addRange: (range: Range) => {
        record.lastAdded = range;
      },
    } as unknown as Selection);
    return record;
  }

  it('REPRO: a blind write after Enter neither steals the caret nor arms a repair', () => {
    // A write that cannot determine the user's caret must leave the visible
    // caret alone AND must not schedule a deferred re-assert or a mutation
    // guardian: those kept dragging the caret back to the dictation position
    // for hundreds of milliseconds, so an Enter pressed in that window split
    // the previous line at the dictation offset.
    vi.useFakeTimers();
    const adapter = makeAdapter();
    const editor = makeComboboxEditor('<p>one</p>');
    stubInnerFocus(editor);
    stubClearedSelection();
    const target = adapter.captureTarget(editor) as InsertionTarget;

    try {
      expect(adapter.previewText(target, ' two').ok).toBe(true);

      // The user presses Shift+Enter and Keep leaves no readable caret.
      editor.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', shiftKey: true, bubbles: true }));
      editor.replaceChildren();
      const line = document.createElement('p');
      line.textContent = 'one two';
      editor.appendChild(line);
      const inner = document.createElement('div');
      editor.appendChild(inner);
      Object.defineProperty(document, 'activeElement', { value: inner, configurable: true });
      vi.restoreAllMocks();
      const afterGesture = stubClearedSelection();

      expect(adapter.previewText(target, ' more').ok).toBe(true);
      // The user's own caret is never asserted by that write…
      expect(afterGesture.lastAdded).toBeNull();

      // …and no deferred pass or repair may assert one afterwards either.
      vi.advanceTimersByTime(600);
      document.dispatchEvent(new Event('selectionchange'));
      line.appendChild(document.createElement('span'));
      document.dispatchEvent(new Event('selectionchange'));
      expect(afterGesture.lastAdded).toBeNull();
      // The words still landed — at the tracked position, additively.
      expect(editor.querySelector('p')!.textContent).toBe('one two more');
    } finally {
      adapter.dispose();
      vi.useRealTimers();
    }
  });

  it('REPRO: existing text is never deleted when a final arrives after a rebuild', () => {
    // Every deletion path must be provable: the final may only replace the
    // exact span this extension wrote. A rebuild that renames/reorders the
    // paragraphs, or a preview node the user typed into, must not turn into a
    // wholesale wipe of text the user already had.
    const adapter = makeAdapter();
    const editor = makeComboboxEditor(
      '<p>alpha beta gamma</p><p>delta epsilon</p><p>zeta eta theta</p>'
    );
    stubInnerFocus(editor);
    select(editor.querySelectorAll('p')[2]!.firstChild!, 4);
    const target = adapter.captureTarget(editor) as InsertionTarget;

    try {
      expect(adapter.previewText(target, ' iota').ok).toBe(true);
      expect(adapter.previewText(target, ' iota kappa').ok).toBe(true);

      // Keep rebuilds: the preview node is replaced by fresh text, and the
      // editor's own text is unchanged, so the reclaim still matches.
      const third = editor.querySelectorAll('p')[2]!;
      third.replaceChildren(document.createTextNode('zeta iota kappa eta theta'));
      (target as { range: Range }).range = detachedRange();

      expect(adapter.insertText(target, ' iota kappa lambda').ok).toBe(true);
      // Only the previewed words changed; the rest of the note is intact.
      expect(lines(editor)).toEqual([
        'alpha beta gamma',
        'delta epsilon',
        'zeta iota kappa lambda eta theta',
      ]);
    } finally {
      adapter.dispose();
    }
  });

  it('REPRO: a rebuilt paragraph does not let a final delete the wrong occurrence', () => {
    // The previewed words also appear EARLIER in the note. The final must
    // reclaim the span it wrote — the one nearest its recorded position — and
    // never the earlier copy.
    const adapter = makeAdapter();
    const editor = makeComboboxEditor('<p>hello there</p><p></p>');
    stubInnerFocus(editor);
    select(editor.querySelectorAll('p')[1]!, 0);
    const target = adapter.captureTarget(editor) as Extract<InsertionTarget, { type: 'contenteditable' }>;

    try {
      expect(adapter.previewText(target, 'hello world').ok).toBe(true);
      expect(lines(editor)).toEqual(['hello there', 'hello world']);

      // Keep rebuilds and detaches the preview node; the words survive as
      // plain text after the earlier identical copy.
      const second = editor.querySelectorAll('p')[1]!;
      second.replaceChildren(document.createTextNode('hello world'));
      (target as { range: Range }).range = detachedRange();

      expect(adapter.insertText(target, 'hello world again').ok).toBe(true);
      expect(lines(editor)).toEqual(['hello there', 'hello world again']);
    } finally {
      adapter.dispose();
    }
  });
});

describe('GoogleKeepAdapter.dispose', () => {
  it('removes the document-level gesture and selectionchange listeners, and is idempotent', () => {
    const removeSpy = vi.spyOn(document, 'removeEventListener');
    const adapter = makeAdapter();

    adapter.dispose();

    expect(removeSpy).toHaveBeenCalledWith('pointerdown', expect.any(Function), true);
    expect(removeSpy).toHaveBeenCalledWith('keydown', expect.any(Function), true);
    expect(removeSpy).toHaveBeenCalledWith('selectionchange', expect.any(Function));
    const callsAfterFirstDispose = removeSpy.mock.calls.length;

    adapter.dispose();
    expect(removeSpy.mock.calls.length).toBe(callsAfterFirstDispose);
  });

  it('clears a pending deferred caret re-assert on dispose', () => {
    vi.useFakeTimers();
    try {
      const editor = makeComboboxEditor('<p><span data-ri="0">abc</span></p>');
      const adapter = makeAdapter() as unknown as {
        scheduleCaretReassert(target: InsertionTarget, offset: number): void;
        dispose(): void;
      };
      const target = {
        type: 'contenteditable',
        element: editor,
        range: document.createRange(),
      } as unknown as InsertionTarget;
      const addRange = vi.fn();
      vi.spyOn(window, 'getSelection').mockReturnValue({
        rangeCount: 0,
        getRangeAt: () => null,
        removeAllRanges: vi.fn(),
        addRange,
      } as unknown as Selection);

      adapter.scheduleCaretReassert(target, 1);

      adapter.dispose();
      vi.runAllTimers();

      expect(addRange).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('a selectionchange after dispose never repairs a caret', () => {
    host = 'keep.google.com';
    const adapter = makeAdapter();
    const editor = makeComboboxEditor('<p><span data-ri="0">abc</span></p>');
    const spanText = (editor.querySelector('span') as HTMLElement).firstChild as Text;
    const addRange = vi.fn();
    vi.spyOn(window, 'getSelection').mockReturnValue({
      rangeCount: 1,
      getRangeAt: () => collapsedRangeIn(editor, 0),
      removeAllRanges: vi.fn(),
      addRange,
    } as unknown as Selection);
    Object.defineProperty(document, 'activeElement', { value: editor, configurable: true });
    const target = adapter.captureTarget(editor) as InsertionTarget;
    expect(adapter.previewText(target, ' def').ok).toBe(true);

    adapter.dispose();
    const callsAfterDispose = addRange.mock.calls.length;
    document.dispatchEvent(new Event('selectionchange'));

    expect(addRange.mock.calls.length).toBe(callsAfterDispose);
  });
});