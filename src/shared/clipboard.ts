/**
 * Clipboard backup for transcripts.
 *
 * Dictated text that has just been typed into someone else's document is easy
 * to lose: a mis-click, a re-rendering editor, an undo. Copying each finished
 * transcript gives the user a backup they can paste from, at no cost to them
 * beyond the clipboard entry itself.
 *
 * Two strategies, because neither is sufficient alone:
 *
 *  1. `navigator.clipboard.writeText` — the modern API. It needs the
 *     extension's `clipboardWrite` permission, and the host page must not block
 *     clipboard writes through Permissions-Policy, which plenty of sites do.
 *     When it works it is invisible: no DOM, no focus change, no selection.
 *  2. A scratch textarea plus `document.execCommand('copy')` — the long-standing
 *     technique for content scripts. It is subject to neither Permissions-Policy
 *     nor the user-gesture requirement (the permission exempts it), but it has
 *     to select real text, which briefly takes focus from the page. The user's
 *     caret is therefore saved and put back, because they are usually typing
 *     into a field on that page and this must not move it.
 */

/** Restorable caret of a form control, if the focused element is one. */
function caretOf(element: Element | null): { start: number; end: number } | null {
  if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
    const start = element.selectionStart;
    const end = element.selectionEnd;
    return typeof start === 'number' && typeof end === 'number' ? { start, end } : null;
  }
  return null;
}

function restoreCaret(element: HTMLElement, caret: { start: number; end: number } | null): void {
  element.focus();
  if (!caret) return;
  try {
    if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
      element.setSelectionRange(caret.start, caret.end);
    }
  } catch {
    // A control that refuses selection (e.g. a number input) keeps the focus it
    // was given; there is nothing further to restore.
  }
}

/**
 * Copy by selecting scratch text. Returns whether the browser reported a copy.
 * Focus and the caret are always restored, including on failure.
 */
function copyViaSelection(text: string): boolean {
  const previous = document.activeElement;
  const caret = caretOf(previous);

  const scratch = document.createElement('textarea');
  scratch.value = text;
  scratch.setAttribute('readonly', '');
  scratch.setAttribute('aria-hidden', 'true');
  scratch.setAttribute('tabindex', '-1');
  // Off-screen rather than hidden: `display:none` (or `visibility:hidden`)
  // elements cannot be selected, and the copy would silently do nothing.
  scratch.style.cssText =
    'position:fixed;top:0;left:0;width:1px;height:1px;padding:0;border:0;margin:0;' +
    'opacity:0;pointer-events:none;z-index:-1;';
  document.body.appendChild(scratch);

  let copied = false;
  try {
    scratch.focus();
    scratch.select();
    scratch.setSelectionRange(0, text.length);
    copied = document.execCommand('copy') === true;
  } catch {
    copied = false;
  } finally {
    scratch.remove();
    if (previous instanceof HTMLElement && previous.isConnected) {
      restoreCaret(previous, caret);
    }
  }
  return copied;
}

/**
 * Put `text` on the clipboard, best effort.
 *
 * Never throws and never rejects: a transcript that is already in the user's
 * field must not be lost because a backup could not be taken. Returns whether
 * the clipboard was actually written, so the caller can say so honestly instead
 * of claiming a backup exists when it does not.
 */
export async function copyToClipboard(text: string): Promise<boolean> {
  if (text.length === 0) return false;
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Blocked by Permissions-Policy, an unfocused document, or a denied
    // permission. Fall through to the selection-based copy, which is exempt.
  }
  try {
    return copyViaSelection(text);
  } catch {
    return false;
  }
}
