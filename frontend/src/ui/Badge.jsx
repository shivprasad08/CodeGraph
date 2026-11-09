import { forwardRef } from 'react';
import { cn } from '../lib/cn';
import { focusRing } from './focusRing';

const TONE_DOT = {
  high: 'bg-cg-sev-high',
  med: 'bg-cg-sev-med',
  low: 'bg-cg-sev-low',
  success: 'bg-cg-success',
  file: 'bg-cg-node-file',
  function: 'bg-cg-node-function',
  class: 'bg-cg-node-class',
  entry: 'bg-cg-node-entry',
};

/**
 * Badge — ONLY for interactive filter chips or meaningful status (e.g. severity,
 * node type). Never decorative metadata. The label carries the meaning; the
 * colour dot is a secondary cue.
 * @param {object} props
 * @param {'neutral'|'high'|'med'|'low'|'success'|'file'|'function'|'class'|'entry'} [props.tone='neutral']
 * @param {() => void} [props.onClick] Makes it a filter chip (button with aria-pressed).
 * @param {boolean} [props.selected] Pressed state for filter chips.
 */
const Badge = forwardRef(function Badge(
  { tone = 'neutral', onClick, selected = false, className, children, ...props },
  ref,
) {
  const interactive = typeof onClick === 'function';
  const Component = interactive ? 'button' : 'span';
  return (
    <Component
      ref={ref}
      {...(interactive ? { type: 'button', 'aria-pressed': selected, onClick } : {})}
      className={cn(
        'inline-flex h-6 items-center gap-1.5 rounded-cg-control border px-2',
        'font-cg-sans text-cg-xs font-medium',
        interactive
          ? cn(
              'transition-colors duration-cg-fast ease-cg [@media(pointer:coarse)]:min-h-11',
              selected
                ? 'border-cg-text bg-cg-hover text-cg-text'
                : 'border-cg-border-strong text-cg-secondary hover:bg-cg-hover hover:text-cg-text',
              focusRing,
            )
          : 'border-cg-border-strong text-cg-text',
        className,
      )}
      {...props}
    >
      {TONE_DOT[tone] && <span aria-hidden="true" className={cn('h-1.5 w-1.5 rounded-full', TONE_DOT[tone])} />}
      {children}
    </Component>
  );
});

export default Badge;
