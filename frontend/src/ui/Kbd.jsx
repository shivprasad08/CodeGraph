import { cn } from '../lib/cn';

/**
 * Kbd — small mono key cap, e.g. <Kbd>⌘K</Kbd>, <Kbd>/</Kbd>, <Kbd>Esc</Kbd>.
 * @param {object} props
 * @param {string} [props.className]
 */
export default function Kbd({ className, children, ...props }) {
  return (
    <kbd
      className={cn(
        'inline-flex h-5 min-w-5 items-center justify-center rounded px-1',
        'border border-cg-border-strong bg-cg-raised',
        'font-cg-mono text-cg-xs font-medium text-cg-secondary',
        className,
      )}
      {...props}
    >
      {children}
    </kbd>
  );
}
