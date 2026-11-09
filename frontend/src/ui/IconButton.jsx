import { forwardRef } from 'react';
import { cn } from '../lib/cn';
import { focusRing } from './focusRing';
import Kbd from './Kbd';
import Tooltip from './Tooltip';

const VARIANTS = {
  ghost: 'bg-transparent text-cg-secondary hover:bg-cg-hover hover:text-cg-text',
  secondary: 'bg-cg-raised text-cg-text border border-cg-border-strong hover:bg-cg-hover',
};

const SIZES = { sm: 'h-8 w-8', md: 'h-9 w-9' };

/**
 * IconButton — square icon-only button with an accessible name and a tooltip.
 * @param {object} props
 * @param {string} props.label Required. Used as aria-label and tooltip text.
 * @param {string} [props.shortcut] Shown in the tooltip as a key cap, e.g. "⌘K".
 * @param {import('react').ReactNode} props.children A Lucide icon element (16px; 20px in primary toolbars).
 * @param {'ghost'|'secondary'} [props.variant='ghost']
 * @param {'sm'|'md'} [props.size='md'] 32 / 36px; hit area grows to 44px on touch.
 * @param {boolean} [props.tooltip=true] Set false where a tooltip would get in the way, e.g. a
 *   dialog close button that receives focus on open (Esc would close the tooltip, not the dialog).
 */
const IconButton = forwardRef(function IconButton(
  { label, shortcut, tooltip = true, variant = 'ghost', size = 'md', type = 'button', className, children, ...props },
  ref,
) {
  if (import.meta.env.DEV && !label) {
    console.error('IconButton: the `label` prop is required.');
  }
  const button = (
    <button
      ref={ref}
      type={type}
      aria-label={label}
      className={cn(
        'relative inline-flex shrink-0 items-center justify-center rounded-cg-control',
        'transition-colors duration-cg-fast ease-cg',
        'disabled:cursor-not-allowed disabled:opacity-50',
        // 44×44px hit area on touch without changing the visual size
        "[@media(pointer:coarse)]:before:absolute [@media(pointer:coarse)]:before:left-1/2 [@media(pointer:coarse)]:before:top-1/2 [@media(pointer:coarse)]:before:h-11 [@media(pointer:coarse)]:before:w-11 [@media(pointer:coarse)]:before:-translate-x-1/2 [@media(pointer:coarse)]:before:-translate-y-1/2 [@media(pointer:coarse)]:before:content-['']",
        focusRing,
        VARIANTS[variant],
        SIZES[size],
        className,
      )}
      {...props}
    >
      {children}
    </button>
  );
  if (!tooltip) return button;
  return (
    <Tooltip
      content={
        <>
          <span>{label}</span>
          {shortcut && <Kbd>{shortcut}</Kbd>}
        </>
      }
    >
      {button}
    </Tooltip>
  );
});

export default IconButton;
