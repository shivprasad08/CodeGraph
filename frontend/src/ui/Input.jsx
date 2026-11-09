import { forwardRef, useId } from 'react';
import { cn } from '../lib/cn';

/**
 * Input — text field with a required label, optional hint and error.
 * Hint and error are linked with aria-describedby; error sets aria-invalid.
 * @param {object} props
 * @param {string} props.label Required. Visible unless hideLabel is set.
 * @param {boolean} [props.hideLabel] Keeps the label for screen readers only. Use only
 *   when the surrounding UI makes the purpose obvious.
 * @param {string} [props.hint]
 * @param {string} [props.error] Error text; also switches the border to the error colour.
 * @param {import('react').ReactNode} [props.prefix] Static text before the value, e.g. "github.com/".
 * @param {import('react').ReactNode} [props.suffix] Static text or a control after the value.
 * @param {string} [props.id] Defaults to a generated id.
 * @param {string} [props.className] Classes for the outer wrapper.
 * @param {string} [props.inputClassName] Classes for the <input>.
 */
const Input = forwardRef(function Input(
  { label, hideLabel = false, hint, error, prefix, suffix, id, className, inputClassName, ...props },
  ref,
) {
  const generatedId = useId();
  const inputId = id || generatedId;
  const hintId = hint ? `${inputId}-hint` : undefined;
  const errorId = error ? `${inputId}-error` : undefined;
  const describedBy = [props['aria-describedby'], hintId, errorId].filter(Boolean).join(' ') || undefined;

  if (import.meta.env.DEV && !label) {
    console.error('Input: the `label` prop is required.');
  }

  return (
    <div className={cn('flex flex-col gap-1.5 font-cg-sans', className)}>
      <label
        htmlFor={inputId}
        className={cn('text-cg-sm font-medium text-cg-text', hideLabel && 'sr-only')}
      >
        {label}
      </label>
      <div
        className={cn(
          'flex h-9 items-center overflow-hidden rounded-cg-control border bg-cg-canvas [@media(pointer:coarse)]:min-h-11',
          'transition-colors duration-cg-fast ease-cg',
          'focus-within:outline focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-cg-focus',
          error ? 'border-cg-sev-high' : 'border-cg-border-strong',
          props.disabled && 'cursor-not-allowed opacity-50',
        )}
      >
        {prefix && (
          <span className="select-none whitespace-nowrap pl-3 font-cg-mono text-cg-sm text-cg-tertiary">
            {prefix}
          </span>
        )}
        <input
          ref={ref}
          id={inputId}
          aria-invalid={error ? true : undefined}
          {...props}
          aria-describedby={describedBy}
          className={cn(
            'h-full min-w-0 flex-1 bg-transparent text-cg-sm text-cg-text outline-none',
            'placeholder:text-cg-tertiary disabled:cursor-not-allowed',
            prefix ? 'pl-0.5 pr-3' : 'px-3',
            inputClassName,
          )}
        />
        {suffix && <span className="flex items-center pr-1.5 text-cg-sm text-cg-tertiary">{suffix}</span>}
      </div>
      {hint && (
        <p id={hintId} className="text-cg-xs text-cg-tertiary">
          {hint}
        </p>
      )}
      {error && (
        <p id={errorId} className="text-cg-xs text-cg-sev-high">
          {error}
        </p>
      )}
    </div>
  );
});

export default Input;
