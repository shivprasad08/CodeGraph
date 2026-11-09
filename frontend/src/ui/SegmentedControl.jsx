import { useRef } from 'react';
import { cn } from '../lib/cn';
import { focusRing } from './focusRing';

/**
 * SegmentedControl — mutually exclusive options (radiogroup). Arrow keys move
 * and select; only the selected option is in the tab order.
 * @param {string} props.label Accessible name of the group.
 * @param {Array<{value: string, label: string}>} props.options
 * @param {string} props.value
 * @param {(value: string) => void} props.onChange
 */
export default function SegmentedControl({ label, options, value, onChange, className }) {
  const refs = useRef([]);
  const index = Math.max(0, options.findIndex((o) => o.value === value));

  const move = (delta) => {
    const next = (index + delta + options.length) % options.length;
    onChange(options[next].value);
    refs.current[next]?.focus();
  };

  return (
    <div
      role="radiogroup"
      aria-label={label}
      className={cn('inline-flex rounded-cg-control border border-cg-border bg-cg-overlay p-0.5 font-cg-sans shadow-cg-edge', className)}
      onKeyDown={(e) => {
        if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
          e.preventDefault();
          move(1);
        } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
          e.preventDefault();
          move(-1);
        }
      }}
    >
      {options.map((o, i) => {
        const selected = o.value === value;
        return (
          <button
            key={o.value}
            ref={(el) => {
              refs.current[i] = el;
            }}
            type="button"
            role="radio"
            aria-checked={selected}
            tabIndex={selected ? 0 : -1}
            onClick={() => onChange(o.value)}
            className={cn(
              'h-7 rounded-[6px] px-2.5 text-cg-xs font-medium transition-colors duration-cg-fast ease-cg [@media(pointer:coarse)]:min-h-11',
              selected ? 'bg-cg-hover text-cg-text' : 'text-cg-secondary hover:text-cg-text',
              focusRing,
            )}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}
