import { clsx } from 'clsx';
import { extendTailwindMerge } from 'tailwind-merge';

// Register the custom cg-* font sizes; otherwise tailwind-merge reads
// "text-cg-sm" as a text colour and drops it next to "text-cg-text".
const twMerge = extendTailwindMerge({
  extend: {
    classGroups: {
      'font-size': [{ text: ['cg-xs', 'cg-sm', 'cg-base', 'cg-lg', 'cg-xl', 'cg-2xl', 'cg-display'] }],
    },
  },
});

/** Joins class names (clsx) and resolves Tailwind conflicts (tailwind-merge). */
export function cn(...inputs) {
  return twMerge(clsx(inputs));
}
