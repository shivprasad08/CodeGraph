import { forwardRef } from 'react';
import { cn } from '../lib/cn';

/**
 * Panel — raised surface with a 1px hairline border and 12px radius.
 * @param {object} props
 * @param {import('react').ReactNode} [props.title] Header title; header renders when title or actions is set.
 * @param {'h2'|'h3'|'h4'} [props.titleAs='h3'] Heading level for the title.
 * @param {import('react').ReactNode} [props.actions] Header actions (e.g. IconButtons).
 * @param {string} [props.className] Classes for the outer element.
 * @param {string} [props.bodyClassName] Classes for the body (default padding p-4).
 */
const Panel = forwardRef(function Panel(
  { title, titleAs: Title = 'h3', actions, className, bodyClassName, children, ...props },
  ref,
) {
  return (
    <section
      ref={ref}
      className={cn(
        'rounded-cg-panel border border-cg-border bg-cg-raised shadow-cg-edge font-cg-sans',
        className,
      )}
      {...props}
    >
      {(title || actions) && (
        <header className="flex min-h-12 items-center justify-between gap-3 border-b border-cg-border px-4 py-2">
          {title && <Title className="text-cg-sm font-medium text-cg-text">{title}</Title>}
          {actions && <div className="ml-auto flex items-center gap-1">{actions}</div>}
        </header>
      )}
      <div className={cn('p-4', bodyClassName)}>{children}</div>
    </section>
  );
});

export default Panel;
