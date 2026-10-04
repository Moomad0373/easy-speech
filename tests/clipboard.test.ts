import { afterEach, describe, expect, it, vi } from 'vitest';
import { copyToClipboard } from '../src/shared/clipboard';

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

/** The modern path succeeds, and nothing in the DOM is touched. */
function stubAsyncClipboard(result: { ok: boolean } | { fail: Error }) {
  const writeText = vi.fn('fail' in result
    ? async () => { throw result.fail; }
    : async () => { /* resolved */ });
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText },
  });
  return writeText;
}

/** No async API at all (older browser, or an insecure context). */
function removeAsyncClipboard(): void {
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined });
}

/**
 * jsdom has no execCommand, so this stands in for it. The stub also captures
 * whatever element is focused at the moment the copy runs — that is the scratch
 * textarea, and inspecting it is the only way to assert the styles that make the
 * copy possible at all.
 */
function stubExecCommand(result: boolean | Error): {
  execCommand: ReturnType<typeof vi.fn>;
  scratch: () => { position: string; display: string; visibility: string; value: string } | null;
} {
  let captured: HTMLTextAreaElement | null = null;
  const execCommand = vi.fn((command: string) => {
    if (result instanceof Error) throw result;
    const active = document.activeElement;
    captured = active instanceof HTMLTextAreaElement ? active : null;
    return command === 'copy' && result;
  });
  Object.defineProperty(document, 'execCommand', { configurable: true, value: execCommand });
  return {
    execCommand,
    scratch: () => (captured ? {
      position: captured.style.position,
      display: captured.style.display,
      visibility: captured.style.visibility,
      value: captured.value,
    } : null),
  };
}

describe('copyToClipboard', () => {
  it('uses the async clipboard API when it is allowed', async () => {
    const writeText = stubAsyncClipboard({ ok: true });
    const { execCommand } = stubExecCommand(true);

    await expect(copyToClipboard('the transcript')).resolves.toBe(true);

    expect(writeText).toHaveBeenCalledWith('the transcript');
    // The invisible path: no scratch element, no execCommand.
    expect(execCommand).not.toHaveBeenCalled();
    expect(document.querySelector('textarea')).toBeNull();
  });

  it('falls back to a selection copy when the page blocks the async API', async () => {
    // Permissions-Policy: clipboard-write is denied by plenty of sites, and a
    // content script runs in the host page's document.
    stubAsyncClipboard({ fail: new Error('Write permission denied.') });
    const { execCommand } = stubExecCommand(true);

    await expect(copyToClipboard('the transcript')).resolves.toBe(true);
    expect(execCommand).toHaveBeenCalledWith('copy');
  });

  it('falls back when there is no async clipboard at all', async () => {
    removeAsyncClipboard();
    const { execCommand } = stubExecCommand(true);

    await expect(copyToClipboard('the transcript')).resolves.toBe(true);
    expect(execCommand).toHaveBeenCalledWith('copy');
  });

  it('puts the caret back where the user left it', async () => {
    // The fallback has to select real text, which briefly takes focus from the
    // page. The user is normally typing into a field there, and having their
    // cursor jumped to the end of their sentence would be a serious regression.
    removeAsyncClipboard();
    stubExecCommand(true);
    const field = document.createElement('textarea');
    field.value = 'notes so far';
    document.body.appendChild(field);
    field.focus();
    field.setSelectionRange(4, 4);

    await copyToClipboard('the transcript');

    expect(document.activeElement).toBe(field);
    expect(field.selectionStart).toBe(4);
    expect(field.selectionEnd).toBe(4);
  });

  it('leaves nothing behind on the page', async () => {
    removeAsyncClipboard();
    stubExecCommand(true);
    const before = document.body.childElementCount;

    await copyToClipboard('the transcript');

    // The scratch textarea is removed even though it was appended to <body>.
    expect(document.body.childElementCount).toBe(before);
    expect(document.querySelector('textarea')).toBeNull();
  });

  it('keeps the scratch element selectable, or the copy silently fails', async () => {
    // `display:none` and `visibility:hidden` elements cannot be selected, and
    // a copy command on one reports success while copying nothing. The scratch
    // node therefore has to be off-screen and still in the document.
    removeAsyncClipboard();
    const { execCommand, scratch } = stubExecCommand(true);

    await copyToClipboard('the transcript');

    const node = scratch();
    // The capture happening at all is the proof it was in the document and
    // focusable at that moment; by assertion time the cleanup has detached it.
    expect(node).not.toBeNull();
    expect(node!.value).toBe('the transcript');
    expect(node!.position).toBe('fixed');
    expect(node!.display).not.toBe('none');
    expect(node!.visibility).not.toBe('hidden');
    expect(execCommand).toHaveBeenCalledWith('copy');
  });

  it('reports failure rather than pretending a backup exists', async () => {
    stubAsyncClipboard({ fail: new Error('denied') });
    stubExecCommand(false);

    await expect(copyToClipboard('the transcript')).resolves.toBe(false);
  });

  it('never throws, whatever the browser does', async () => {
    stubAsyncClipboard({ fail: new Error('denied') });
    stubExecCommand(new Error('execCommand is not a function'));

    // A transcript is already in the user's field at this point; a missing
    // backup must not turn into a broken dictation.
    await expect(copyToClipboard('the transcript')).resolves.toBe(false);
  });

  it('restores focus even when the copy fails', async () => {
    removeAsyncClipboard();
    stubExecCommand(new Error('boom'));
    const field = document.createElement('input');
    field.value = 'abc';
    document.body.appendChild(field);
    field.focus();
    field.setSelectionRange(1, 1);

    await copyToClipboard('the transcript');

    expect(document.activeElement).toBe(field);
    expect(field.selectionStart).toBe(1);
  });

  it('does nothing for empty text', async () => {
    const writeText = stubAsyncClipboard({ ok: true });
    const { execCommand } = stubExecCommand(true);

    await expect(copyToClipboard('')).resolves.toBe(false);
    expect(writeText).not.toHaveBeenCalled();
    expect(execCommand).not.toHaveBeenCalled();
  });
});
