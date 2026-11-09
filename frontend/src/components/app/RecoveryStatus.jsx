import { RefreshCw, RotateCw, TriangleAlert } from 'lucide-react';
import { cn } from '../../lib/cn';
import { Button } from '../../ui';

/**
 * Design-system error block: severity icon + friendly message (never raw backend
 * text), with "Re-run analysis" when the analysis is gone from the server.
 */
export function InlineError({ message, onRerun, className }) {
  return (
    <div role="alert" className={cn('flex items-start gap-2.5 rounded-cg-control border border-cg-border bg-cg-canvas p-3', className)}>
      <TriangleAlert size={16} strokeWidth={1.5} aria-hidden="true" className="mt-0.5 shrink-0 text-cg-sev-high" />
      <div className="min-w-0 flex-1">
        <p className="text-cg-sm text-cg-text">{message}</p>
        {onRerun && (
          <Button size="sm" variant="secondary" className="mt-2" onClick={onRerun} leadingIcon={<RotateCw size={16} strokeWidth={1.5} aria-hidden="true" />}>
            Re-run analysis
          </Button>
        )}
      </div>
    </div>
  );
}

/** One line shown after a recovery that landed on a newer commit. */
export function RecoveryNotice({ onReloadGraph, className }) {
  return (
    <div role="status" className={cn('flex flex-wrap items-center gap-x-3 gap-y-1 text-cg-xs text-cg-secondary', className)}>
      <span className="min-w-0 flex-1">The repository changed since this analysis — showing answers for the latest commit.</span>
      {onReloadGraph && (
        <Button size="sm" variant="ghost" onClick={onReloadGraph} leadingIcon={<RefreshCw size={14} strokeWidth={1.5} aria-hidden="true" />}>
          Reload graph
        </Button>
      )}
    </div>
  );
}
