import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ContentEditableAdapter } from '../src/content/insertion/ContentEditableAdapter';
import { withWordBoundarySpace } from '../src/content/insertion/InputAdapter';
import type { InsertionTarget } from '../src/shared/types';

let adapter: ContentEditableAdapter;
let addedRange: Range | null;

function makeEditor(html: string): HTMLDivElement {
  const div = document.createElement('div');
  div.id = 'editor';
  div.setAttribute('contenteditable', 'true');
  div.innerHTML = html; // test scaffolding only, never transcript data
  document.body.appendChild(div);
  return div;
}

/** jsdom's Selection is a stub — provide a controllable fake. */
function stubSelection(range: Range | null, active: Element | null = null): void {
  const selection = {
    rangeCount: range ? 1 : 0,
    getRangeAt: () => range,
    removeAllRanges: vi.fn(),
    addRange: (r: Range) => {
      addedRange = r;
    },
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

function selectedRange(node: Node, start: number, end: number): Range {
  const range = document.createRange();
  range.setStart(node, start);
  range.setEnd(node, end);
  return range;
}

beforeEach(() => {
  adapter = new ContentEditableAdapter();
  addedRange = null;
  document.body.innerHTML = '';
  Object.defineProperty(document, 'activeElement', { value: document.body, configurable: true });
  vi.restoreAllMocks();
});

describe('ContentEditableAdapter.captureTarget', () => {
  it('captures the live caret inside the editor', () => {
    const editor = makeEditor('Hello world');
    const text = editor.firstChild as Text;
    stubSelection(collapsedRangeIn(text, 8));
    const target = adapter.captureTarget(editor) as InsertionTarget;
    expect(target?.type).toBe('contenteditable');
    expect(target?.element).toBe(editor);
    expect((target as { range: Range }).range.collapsed).toBe(true);
  });

  it('resolves the editable root from a nested editable child', () => {
    const editor = makeEditor('<span id="inner">text</span>');
    stubSelection(null);
    const target = adapter.captureTarget(editor.querySelector('#inner')!) as InsertionTarget;
    expect(target?.element).toBe(editor);
  });

  it('falls back to end-of-content when there is no selection', () => {
    const editor = makeEditor('abc');
    stubSelection(null);
    const target = adapter.captureTarget(editor) as InsertionTarget;
    const range = (target as { range: Range }).range;
    expect(range.collapsed).toBe(true);
    expect(range.startContainer).toBe(editor);
    expect(range.startOffset).toBe(1); // after all children
  });
});

describe('ContentEditableAdapter.insertText', () => {
  it('separates a new session text from existing text with a space', () => {
    const editor = makeEditor('hello');
    stubSelection(null);
    const target = adapter.captureTarget(editor) as InsertionTarget;
    const insertion = adapter.textBeforeCaret(target);
    expect(withWordBoundarySpace(insertion, 'world')).toBe(' world');
  });

  it('notifies the editor once after each preview and final mutation', () => {
    const editor = makeEditor('');
    stubSelection(null);
    const target = adapter.captureTarget(editor) as InsertionTarget;
    const values: string[] = [];
    editor.addEventListener('input', () => {
      values.push(editor.textContent ?? '');
    });

    expect(adapter.previewText(target, 'hello').ok).toBe(true);
    expect(adapter.previewText(target, 'hello world').ok).toBe(true);
    expect(adapter.insertText(target, 'hello world!').ok).toBe(true);
    expect(adapter.insertText(target, ' again').ok).toBe(true);
    expect(values).toEqual(['hello', 'hello world', 'hello world!', 'hello world! again']);
  });

  it('inserts at a middle caret and collapses it after the inserted text', () => {
    const editor = makeEditor('Hello world');
    const text = editor.firstChild as Text;
    stubSelection(collapsedRangeIn(text, 9)); // Hello wor|ld
    const target = adapter.captureTarget(editor) as InsertionTarget;
    expect(adapter.insertText(target, 'beautiful')).toEqual({ ok: true });
    expect(editor.textContent).toBe('Hello worbeautifulld');
    // caret sits right after the inserted "beautiful" node (editor children:
    // ["Hello wor", "beautiful", "ld"] → caret = editor, offset 2)
    expect(addedRange?.collapsed).toBe(true);
    expect(addedRange?.startContainer).toBe(editor);
    expect(addedRange?.startOffset).toBe(2);
  });

  it('replaces a selected range', () => {
    const editor = makeEditor('Hello world');
    const text = editor.firstChild as Text;
    stubSelection(selectedRange(text, 6, 11)); // select "world"
    const target = adapter.captureTarget(editor) as InsertionTarget;
    adapter.insertText(target, 'everyone');
    expect(editor.textContent).toBe('Hello everyone');
  });

  it('inserts into an empty editor', () => {
    const editor = makeEditor('');
    stubSelection(null);
    const target = adapter.captureTarget(editor) as InsertionTarget;
    adapter.insertText(target, 'first words');
    expect(editor.textContent).toBe('first words');
  });

  it('trims the engine’s leading space when the editor is empty', () => {
    const editor = makeEditor('');
    stubSelection(null);
    const target = adapter.captureTarget(editor) as InsertionTarget;
    // Chrome prefixes utterances with a space (seen in real fa-IR logs).
    adapter.insertText(target, ' first words');
    expect(editor.textContent).toBe('first words');
  });

  it('keeps the engine’s leading space when inserting mid-text', () => {
    const editor = makeEditor('Hello world');
    const text = editor.firstChild as Text;
    stubSelection(collapsedRangeIn(text, 9)); // Hello wor|ld
    const target = adapter.captureTarget(editor) as InsertionTarget;
    adapter.insertText(target, ' big');
    expect(editor.textContent).toBe('Hello wor bigld');
  });

  it('trims the engine’s leading space when the caret follows a leading <br>', () => {
    // Judged in the textContent coordinate space: a <br> contributes no text,
    // so a caret right after it is still "very start". (Real Chrome renders
    // <br> as a newline inside Range.toString(), which misjudged this.)
    const editor = makeEditor('<br>next');
    const text = editor.lastChild as Text;
    stubSelection(collapsedRangeIn(text, 0));
    const target = adapter.captureTarget(editor) as InsertionTarget;
    adapter.insertText(target, ' first');
    expect(editor.textContent).toBe('firstnext');
  });

  it('keeps the engine’s leading space once real text precedes the caret', () => {
    const editor = makeEditor('<br>next');
    const text = editor.lastChild as Text;
    stubSelection(collapsedRangeIn(text, 4)); // next|
    const target = adapter.captureTarget(editor) as InsertionTarget;
    adapter.insertText(target, ' more');
    expect(editor.textContent).toBe('next more');
  });

  it('builds safe text nodes + <br> for multiline transcripts', () => {
    const editor = makeEditor('');
    stubSelection(null);
    const target = adapter.captureTarget(editor) as InsertionTarget;
    adapter.insertText(target, 'a\n\nb');
    expect(editor.textContent).toBe('ab');
    expect(editor.childNodes.length).toBe(4); // "a", <br>, <br>, "b"
    expect(editor.childNodes[1]?.nodeName).toBe('BR');
    expect(editor.childNodes[2]?.nodeName).toBe('BR');
  });

  it('treats transcripts as untrusted text — never as HTML', () => {
    const editor = makeEditor('');
    stubSelection(null);
    const target = adapter.captureTarget(editor) as InsertionTarget;
    adapter.insertText(target, '<img src=x onerror=alert(1)>');
    expect(editor.querySelector('img')).toBeNull();
    expect(editor.textContent).toBe('<img src=x onerror=alert(1)>');
  });

  it('fails validation when the element was removed from the document', () => {
    const editor = makeEditor('abc');
    stubSelection(null);
    const target = adapter.captureTarget(editor) as InsertionTarget;
    editor.remove();
    const result = adapter.insertText(target, 'x');
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/removed/);
  });
});

describe('ContentEditableAdapter — live preview', () => {
  it('inserts a preview text node at the caret and rewrites it in place', () => {
    const editor = makeEditor('Hello world');
    const text = editor.firstChild as Text;
    stubSelection(collapsedRangeIn(text, 5)); // Hello| world
    const target = adapter.captureTarget(editor) as InsertionTarget;

    expect(adapter.previewText(target, ' big')).toEqual({ ok: true });
    expect(editor.textContent).toBe('Hello big world');
    const node = (target as { previewNode: Text | null }).previewNode;
    expect(node?.data).toBe(' big');
    expect(editor.childNodes.length).toBe(3); // "Hello", preview node, " world"

    adapter.previewText(target, ' beautiful');
    expect(editor.textContent).toBe('Hello beautiful world');
    expect((target as { previewNode: Text | null }).previewNode).toBe(node);
    expect(editor.childNodes.length).toBe(3); // same node rewritten, nothing duplicated
  });

  it('replaces the preview node with the final transcript on commit', () => {
    const editor = makeEditor('');
    stubSelection(null);
    const target = adapter.captureTarget(editor) as InsertionTarget;

    adapter.previewText(target, ' first');
    adapter.insertText(target, ' first words');
    // leading engine space trimmed because the preview sat at the very start
    expect(editor.textContent).toBe('first words');
    expect((target as { previewNode: Text | null }).previewNode).toBeNull();

    // the next phrase continues after the committed text
    adapter.insertText(target, ' again');
    expect(editor.textContent).toBe('first words again');
  });

  it('replaces the preview with a multiline final (text nodes + <br>)', () => {
    const editor = makeEditor('');
    stubSelection(null);
    const target = adapter.captureTarget(editor) as InsertionTarget;

    adapter.previewText(target, 'x');
    adapter.insertText(target, 'a\nb');
    expect(editor.textContent).toBe('ab');
    expect(editor.childNodes.length).toBe(3); // "a", <br>, "b"
  });

  it('trims the engine’s leading space when the preview starts a field', () => {
    const editor = makeEditor('');
    stubSelection(null);
    const target = adapter.captureTarget(editor) as InsertionTarget;
    adapter.previewText(target, ' hello');
    expect(editor.textContent).toBe('hello');
  });

  it('starts a fresh preview node after the previous one was detached', () => {
    const editor = makeEditor('');
    stubSelection(null);
    const target = adapter.captureTarget(editor) as InsertionTarget;
    adapter.previewText(target, ' one');
    expect(editor.textContent).toBe('one'); // leading space trimmed at very start

    const staleNode = (target as { previewNode: Text | null }).previewNode!;
    staleNode.remove(); // simulate a site re-render

    adapter.previewText(target, ' two');
    expect(editor.textContent).toBe('two'); // fresh node at the captured range
    expect((target as { previewNode: Text | null }).previewNode).not.toBe(staleNode);
  });

  it('resetPreview keeps the previewed text but drops the tracking', () => {
    const editor = makeEditor('');
    stubSelection(null);
    const target = adapter.captureTarget(editor) as InsertionTarget;
    adapter.previewText(target, ' spoken');
    adapter.resetPreview(target);
    expect(editor.textContent).toBe('spoken');
    expect((target as { previewNode: Text | null }).previewNode).toBeNull();
  });

  it('refuses to preview when the element was removed', () => {
    const editor = makeEditor('abc');
    stubSelection(null);
    const target = adapter.captureTarget(editor) as InsertionTarget;
    editor.remove();
    expect(adapter.previewText(target, 'x').ok).toBe(false);
  });
});

describe('ContentEditableAdapter — site DOM normalization (regression: duplicated words)', () => {
  /**
   * Reproduces ChatGPT's composer behavior: after the preview is inserted,
   * the site re-normalizes the editor (merges/recreates the text nodes),
   * detaching our preview node while keeping its text and the caret.
   * The final commit must REPLACE the previewed words — never append.
   */
  function simulateSiteNormalization(editor: HTMLElement): void {
    const merged = document.createTextNode(editor.textContent ?? '');
    editor.replaceChildren(merged);
    stubSelection(collapsedRangeIn(editor, 1)); // caret after the merged node
  }

  beforeEach(() => {
    document.body.innerHTML = '';
    vi.restoreAllMocks();
  });

  it('replaces a site-normalized preview instead of writing the words twice', () => {
    const editor = makeEditor('hello');
    stubSelection(collapsedRangeIn(editor.firstChild as Text, 5));
    const target = adapter.captureTarget(editor) as InsertionTarget;

    adapter.previewText(target, ' دوباره');
    expect(editor.textContent).toBe('hello دوباره');

    simulateSiteNormalization(editor);
    expect((target as { previewNode: Text | null }).previewNode?.isConnected).toBe(false);

    adapter.insertText(target, ' دوباره');
    expect(editor.textContent).toBe('hello دوباره'); // NOT 'hello دوباره دوباره'
  });

  it('replaces the preview on the NEXT interim after normalization', () => {
    const editor = makeEditor('hello');
    stubSelection(collapsedRangeIn(editor.firstChild as Text, 5));
    const target = adapter.captureTarget(editor) as InsertionTarget;

    adapter.previewText(target, ' one');
    simulateSiteNormalization(editor);
    adapter.previewText(target, ' two');
    expect(editor.textContent).toBe('hello two');
  });

  it('keeps working when the site deleted the previewed words entirely', () => {
    const editor = makeEditor('hello');
    stubSelection(collapsedRangeIn(editor.firstChild as Text, 5));
    const target = adapter.captureTarget(editor) as InsertionTarget;

    adapter.previewText(target, ' spoken');
    editor.textContent = 'hello'; // site reverted the preview
    stubSelection(collapsedRangeIn(editor.firstChild as Text, 5), editor);

    adapter.insertText(target, ' spoken');
    expect(editor.textContent).toBe('hello spoken');
  });

  it('replaces a normalized preview that the site merged into other text', () => {
    const editor = makeEditor('hello');
    stubSelection(collapsedRangeIn(editor.firstChild as Text, 5));
    const target = adapter.captureTarget(editor) as InsertionTarget;

    adapter.previewText(target, ' دوباره');
    // Site merged the preview into a wrapper div (not a plain text node).
    const wrapper = document.createElement('div');
    wrapper.textContent = editor.textContent;
    editor.replaceChildren(wrapper);
    stubSelection(collapsedRangeIn(wrapper.firstChild as Text, wrapper.textContent!.length), wrapper);

    adapter.insertText(target, ' دوباره');
    expect(editor.textContent).toBe('hello دوباره');
  });

  it('reclaims a preview whose spaces the site rewrote as non-breaking spaces', () => {
    const editor = makeEditor('hello');
    stubSelection(collapsedRangeIn(editor.firstChild as Text, 5));
    const target = adapter.captureTarget(editor) as InsertionTarget;

    adapter.previewText(target, ' قطع کردم و مجدد');
    // ChatGPT rewrites regular spaces as \u00A0 during normalization.
    const rewritten = (editor.textContent ?? '').replace(/ /g, '\u00A0');
    const merged = document.createTextNode(rewritten);
    editor.replaceChildren(merged);
    stubSelection(collapsedRangeIn(editor, 1), editor);

    adapter.insertText(target, ' قطع کردم و مجدد');
    expect(editor.textContent).toBe('hello قطع کردم و مجدد'); // not doubled
  });

  it('reclaims the occurrence NEAREST the preview, not the first repeat in the editor', () => {
    // 'two' already exists earlier in the note — the live preview sits at the
    // end. Keep re-renders (preview node detached, words survive); the next
    // interim must rewrite the END occurrence, never the earlier one.
    const editor = makeEditor('one two three');
    stubSelection(collapsedRangeIn(editor.firstChild as Text, 13));
    const target = adapter.captureTarget(editor) as InsertionTarget;

    adapter.previewText(target, ' two');
    expect(editor.textContent).toBe('one two three two');

    simulateSiteNormalization(editor);

    adapter.previewText(target, ' four');
    expect(editor.textContent).toBe('one two three four'); // NOT 'one four three two'
  });

  it('does not reclaim a short preview from the middle of another word', () => {
    const editor = makeEditor('extension');
    stubSelection(collapsedRangeIn(editor.firstChild as Text, 9));
    const target = adapter.captureTarget(editor) as InsertionTarget;

    adapter.previewText(target, ' ex');
    expect(editor.textContent).toBe('extension ex');

    editor.replaceChildren(document.createTextNode('extension'));
    stubSelection(null, editor);
    adapter.previewText(target, ' plain');

    expect(editor.textContent).toBe('extension plain');
  });

  it('final commit after normalization keeps the caret at the reclaimed preview', () => {
    const editor = makeEditor('hello world');
    stubSelection(collapsedRangeIn(editor.firstChild as Text, 11));
    const target = adapter.captureTarget(editor) as InsertionTarget;

    adapter.previewText(target, ' world');
    expect(editor.textContent).toBe('hello world world');

    simulateSiteNormalization(editor);
    adapter.insertText(target, ' world'); // final replaces the previewed words
    expect(editor.textContent).toBe('hello world world');

    // The caret must sit after the RECLAIMED preview (at the end), so the
    // next phrase appends at the end instead of splicing into the middle.
    adapter.insertText(target, ' tail');
    expect(editor.textContent).toBe('hello world world tail');
  });

  it('continues at the original caret when the site drops the previewed words (not behind all text)', () => {
    const editor = makeEditor('hello world');
    stubSelection(collapsedRangeIn(editor.firstChild as Text, 5));
    const target = adapter.captureTarget(editor) as InsertionTarget;

    adapter.previewText(target, ' beautiful');
    expect(editor.textContent).toBe('hello beautiful world');

    // The site's next render drops the previewed words entirely.
    editor.replaceChildren(document.createTextNode('hello world'));
    stubSelection(null, editor);

    // The next interim must continue at the original caret (offset 6) — the
    // old fallback anchored to the end of content, so the preview (and every
    // phrase after it) landed behind all the existing text.
    adapter.previewText(target, ' sunny');
    expect(editor.textContent).toBe('hello sunny world');
  });
});

describe('ContentEditableAdapter — split preview regression', () => {
  it('deletes only the cross-node DOM range and inserts at its collapsed boundary', () => {
    const editor = makeEditor('<span>hello beau</span><strong>tiful <em>day tail</em></strong>');
    const range = document.createRange();
    range.setStart(editor.querySelector('span')!.firstChild!, 5);
    range.setEnd(editor.querySelector('em')!.firstChild!, 3);
    expect(range.toString()).toBe(' beautiful day');

    range.deleteContents();
    expect(editor.innerHTML).toBe('<span>hello</span><strong><em> tail</em></strong>');
    expect(range.collapsed).toBe(true);
    range.insertNode(document.createTextNode(' sunny afternoon'));
    expect(editor.innerHTML).toBe('<span>hello</span> sunny afternoon<strong><em> tail</em></strong>');
  });

  it.each(['preview', 'final'] as const)('reclaims a preview across nested text nodes for %s', (operation) => {
    const editor = makeEditor('hello tail');
    stubSelection(collapsedRangeIn(editor.firstChild!, 5));
    const target = adapter.captureTarget(editor) as InsertionTarget;
    expect(adapter.previewText(target, ' beautiful day')).toEqual({ ok: true });
    editor.innerHTML = '<span>hello beau</span><strong>tiful <em>day tail</em></strong>';
    stubSelection(null, editor);

    const result = operation === 'preview'
      ? adapter.previewText(target, ' sunny afternoon')
      : adapter.insertText(target, ' sunny afternoon');

    expect(editor.innerHTML).toBe('<span>hello</span> sunny afternoon<strong><em> tail</em></strong>');
    expect(result).toEqual({ ok: true });
    expect(editor.textContent).toBe('hello sunny afternoon tail');
    expect(adapter.insertText(target, operation === 'preview' ? ' sunny afternoon' : '!')).toEqual({ ok: true });
    expect(editor.textContent).toBe(operation === 'preview'
      ? 'hello sunny afternoon tail'
      : 'hello sunny afternoon! tail');
  });
});

describe('ContentEditableAdapter — stale range resilience', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    vi.restoreAllMocks();
  });

  it('records preview offsets in textContent space (stable across <br> and rebuilds)', () => {
    // The reclaim matcher searches root.textContent, so the recorded offset
    // must count textContent characters: a <br> contributes nothing there
    // (Range.toString may render it as a line break in real browsers, which
    // skewed reclaim onto the wrong repeated word on multiline notes).
    const editor = makeEditor('<p>ab<br>cd</p>');
    stubSelection(null, document.body);
    const target = adapter.captureTarget(editor) as InsertionTarget;
    expect(adapter.previewText(target, ' XY').ok).toBe(true);
    expect(editor.textContent).toBe('abcd XY');
    expect((target as { previewOffset: number | null }).previewOffset).toBe('abcd'.length);
  });

  it('re-anchors and retries instead of throwing when range mutations fail mid-session', () => {
    // Real-world trigger (e.g. a site re-render invalidating captured offsets)
    // surfaces as a throw inside Range.deleteContents / insertNode. The
    // adapter must catch it, re-anchor to the end of the live content, and
    // retry — letting the throw escape would drop the final transcript
    // silently while recognition keeps "inserting" into the void.
    const editor = makeEditor('<p>old</p>');
    const target = adapter.captureTarget(editor) as InsertionTarget;
    const original = Range.prototype.deleteContents;
    let calls = 0;
    Range.prototype.deleteContents = function patched(): void {
      calls += 1;
      if (calls === 1) {
        throw new Error('simulated stale range');
      }
      return original.call(this);
    };
    try {
      const result = adapter.insertText(target, 'new');
      expect(result).toEqual({ ok: true });
      expect(editor.textContent).toBe('oldnew');
    } finally {
      Range.prototype.deleteContents = original;
    }
  });

  it('retries at the remembered position, not behind all the text, when a mutation fails mid-session', () => {
    // Regression: the catch-retry used to anchor to END OF CONTENT
    // unconditionally, so a mid-text dictation session that hit a stale
    // range suddenly continued behind all the existing text — the observed
    // "cursor moves behind the existing text".
    const editor = makeEditor('hello world');
    const text = editor.firstChild as Text;
    stubSelection(collapsedRangeIn(text, 5));
    const target = adapter.captureTarget(editor) as InsertionTarget;

    // First phrase succeeds mid-text and is remembered as the resume anchor.
    expect(adapter.insertText(target, ' X').ok).toBe(true);
    expect(editor.textContent).toBe('hello X world');

    const original = Range.prototype.deleteContents;
    let calls = 0;
    Range.prototype.deleteContents = function patched(): void {
      calls += 1;
      if (calls === 1) {
        throw new Error('simulated stale range');
      }
      return original.call(this);
    };
    try {
      const result = adapter.insertText(target, ' Y');
      expect(result.ok).toBe(true);
    } finally {
      Range.prototype.deleteContents = original;
    }

    // Continued where the user was (mid-text), NOT appended at the end.
    expect(editor.textContent).toBe('hello X Y world');
  });

  it('ignores a rebuild artifact that collapses the live caret to the editor start', () => {
    // Real Chrome/Edge remap a selection orphaned by a site rebuild to
    // (root, 0) — the very start of the editor. Adopting it typed the next
    // phrase at the FRONT of the text (the "caret jumps to the front" half).
    const editor = makeEditor('hello world');
    stubSelection(collapsedRangeIn(editor.firstChild as Text, 11), editor);
    const target = adapter.captureTarget(editor) as InsertionTarget;
    expect(adapter.insertText(target, ' one').ok).toBe(true);
    expect(editor.textContent).toBe('hello world one');

    // Site rebuild: the browser collapses the live selection to (editor, 0).
    stubSelection(collapsedRangeIn(editor, 0), editor);
    expect(adapter.previewText(target, ' two').ok).toBe(true);

    // Must continue at the tracked end, not at the start of the editor.
    expect(editor.textContent).toBe('hello world one two');
  });

  it('still honors a genuine user caret placed in the first text node', () => {
    // The rejection above must not block a real click at the beginning: in
    // real browsers that lands INSIDE a Text node at offset 0.
    const editor = makeEditor('hello world');
    stubSelection(collapsedRangeIn(editor.firstChild as Text, 0), editor);
    const target = adapter.captureTarget(editor) as InsertionTarget;

    expect(adapter.previewText(target, 'X').ok).toBe(true);
    expect(editor.textContent).toBe('Xhello world');
  });

  it('re-anchors the stored range when the preview node is detached by a re-render', () => {
    // Keep rebuilds its <p> on every input event. When the next interim
    // arrives, the previous preview node is detached — the stored range
    // still points into the detached subtree. The adapter must move the
    // range back into the live DOM (end of content) so the new preview is
    // written where the user watches, instead of into the void.
    const editor = makeEditor('<p>hello</p>');
    stubSelection(null, document.body);
    const target = adapter.captureTarget(editor) as InsertionTarget;
    expect(adapter.previewText(target, ' one').ok).toBe(true);
    expect(editor.textContent).toBe('hello one');

    // Site rebuilds: new <p> holding the same words, old preview node gone.
    const p = editor.querySelector('p') as HTMLParagraphElement;
    const rebuilt = document.createElement('p');
    rebuilt.textContent = p.textContent;
    editor.replaceChildren(rebuilt);

    expect(adapter.previewText(target, ' two').ok).toBe(true);
    expect(editor.textContent).toBe('hello two');
  });
});




describe('ContentEditableAdapter - verified caret anchor after a site rebuild', () => {
  beforeEach(() => {
    adapter = new ContentEditableAdapter();
    addedRange = null;
    document.body.innerHTML = '';
    Object.defineProperty(document, 'activeElement', { value: document.body, configurable: true });
    vi.restoreAllMocks();
  });

  it('re-finds the dictation position when a rebuild added text before it', () => {
    // The remembered resume position is a character offset, and a rebuild that
    // changes the text before it (a bullet prefix, a renumbered list, a
    // re-wrapped line) leaves that offset pointing into the middle of a word.
    // Dictation then continues mid-word, and the user's next Enter splits the
    // line there - leaving its first characters behind, as reported on Google
    // Keep. The anchor keeps the text around the position, so it survives.
    const editor = makeEditor('alpha beta');
    stubSelection(collapsedRangeIn(editor.firstChild as Text, 10), editor); // alpha beta|
    const target = adapter.captureTarget(editor) as InsertionTarget;
    expect(adapter.insertText(target, 'gamma').ok).toBe(true);
    expect(editor.textContent).toBe('alpha betagamma');

    // The site rebuilds and prefixes the line (a checklist item, say). The
    // tracked range dies with the old nodes.
    editor.textContent = '\u2022 alpha betagamma';
    stubSelection(null, editor);

    expect(adapter.insertText(target, ' delta').ok).toBe(true);
    // Continued at the end of the dictated words, never inside them.
    expect(editor.textContent).toBe('\u2022 alpha betagamma delta');
  });

  it('continues after text the user typed at the caret while the selection is unreadable', () => {
    // The insertion point moves without telling the adapter whenever the user
    // types mid-dictation and the site rebuilds: the recorded offset is now
    // BEHIND the real caret, so the next words were written before what the
    // user just typed - rearranging their line, and the following Enter split
    // it in the wrong place. The anchor's trailing context identifies the real
    // position.
    const editor = makeEditor('alpha beta gamma');
    stubSelection(collapsedRangeIn(editor.firstChild as Text, 10), editor); // alpha beta| gamma
    const target = adapter.captureTarget(editor) as InsertionTarget;
    expect(adapter.insertText(target, 'X').ok).toBe(true);
    expect(editor.textContent).toBe('alpha betaX gamma');

    // The user types at the caret and the site rebuilds the editor around it,
    // so the tracked range is detached and no live selection can be followed.
    editor.textContent = 'alpha betaXZed gamma';
    stubSelection(null, editor);

    expect(adapter.insertText(target, ' Y').ok).toBe(true);
    // The words land AFTER what the user typed, in order, with nothing moved.
    expect(editor.textContent).toBe('alpha betaXZed Y gamma');
  });
});