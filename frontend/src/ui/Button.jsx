import { forwardRef } from 'react';
import { cn } from '../lib/cn';
import { focusRing } from './focusRing';
import Spinner from './Spinner';

const VARIANTS = {
  primary: 'bg-cg-primary text-cg-on-primary hover:bg-cg-primary-hover',
  secondary: 'bg-cg-raised text-cg-text border border-cg-border-strong hover:bg-cg-hover',
  ghost: 'bg-transparent text-cg-text hover:bg-cg-hover',
  // Text-only red until hover; hover fills red with dark text (5.1:1; light text would be 3.4:1)
  danger: 'bg-transparent text-cg-sev-high hover:bg-cg-sev-high hover:text-cg-on-primary',
};

const SIZES = {
  sm: 'h-8 px-3 gap-1.5 text-cg-sm',
  md: 'h-9 px-4 gap-2 text-cg-sm',
  lg: 'h-11 px-5 gap-2 text-cg-base',
};

/**
 * Button. The label should be verb-first ("Analyze repo"); that is the caller's job.
 * @param {object} props
 * @param {'primary'|'secondary'|'ghost'|'danger'} [props.variant='secondary']
 * @param {'sm'|'md'|'lg'} [props.size='md'] Heights 32 / 36 / 44px; at least 44px on touch.
 * @param {boolean} [props.loading] Shows a spinner, keeps the width, sets aria-busy, blocks clicks.
 * @param {boolean} [props.disabled]
 * @param {import('react').ReactNode} [props.leadingIcon] Lucide icon element (16px).
 * @param {import('react').ReactNode} [props.trailingIcon]
 */
const Button = forwardRef(function Button(
  {
    variant = 'secondary',
    size = 'md',
    loading = false,
    disabled = false,
    leadingIcon,
    trailingIcon,
    type = 'button',
    className,
    children,
    ...props
  },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={cn(
        'relative inline-flex select-none items-center justify-center whitespace-nowrap',
        'rounded-cg-control font-cg-sans font-medium',
        'transition-colors duration-cg-fast ease-cg [@media(pointer:coarse)]:min-h-11',
        'disabled:cursor-not-allowed disabled:opacity-50',
        loading && 'disabled:cursor-wait disabled:opacity-100',
        focusRing,
        VARIANTS[variant],
        SIZES[size],
        className,
      )}
      {...props}
    >
      {/* Content stays in the layout while loading so the width does not change */}
      <span className={cn('inline-flex items-center gap-[inherit]', loading && 'invisible')}>
        {leadingIcon}
        {children}
        {trailingIcon}
      </span>
      {loading && (
        <span className="absolute inset-0 flex items-center justify-center">
          <Spinner />
        </span>
      )}
    </button>
  );
});

export default Button;
