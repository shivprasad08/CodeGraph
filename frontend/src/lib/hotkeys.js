// Helpers for single-key shortcuts that must not fire while the user is typing.

export function isTypingTarget(target) {
  if (!target || !(target instanceof Element)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  if (tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (tag === 'INPUT') {
    const type = (target.getAttribute('type') || 'text').toLowerCase();
    return !['button', 'checkbox', 'radio', 'submit', 'reset', 'range', 'color'].includes(type);
  }
  return false;
}

/** True for a key press with no Ctrl/Meta/Alt (Shift allowed, e.g. "+"). */
export const isPlainKey = (e) => !e.ctrlKey && !e.metaKey && !e.altKey;

/** Platform label for the command key. */
export const MOD_KEY =
  typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent) ? '⌘' : 'Ctrl';
