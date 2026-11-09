// Light wrapper (no React Flow import): lazy-loads the renderer and owns the full-screen dialog.
import { lazy, Suspense, useState } from 'react';
import { Expand } from 'lucide-react';
import { Button, Dialog, DialogContent } from '../../ui';

const FlowDiagram = lazy(() => import('./FlowDiagram'));

function DiagramSkeleton({ height }) {
  return (
    <div
      role="status"
      aria-label="Loading diagram"
      className="flex w-full items-center justify-center rounded-cg-control border border-cg-border bg-cg-canvas text-cg-xs text-cg-tertiary"
      style={{ height }}
    >
      Drawing diagram…
    </div>
  );
}

/**
 * Diagram with lazy renderer + full-screen dialog (~90vw × 85vh).
 * @param {object} props.spec FlowDiagram spec
 * @param {string} props.title Dialog title / accessible name
 * @param {string} [props.header] Optional card header line (shown with an "Open full screen" button)
 * @param {(specNode) => void} [props.onNodeClick]
 * @param {object} [props.dirColorMap]
 * @param {number|string} [props.height=320]
 * @param {boolean} [props.wheelZoom=false]
 */
export default function DiagramFrame({ spec, title, header, onNodeClick, dirColorMap, height = 320, wheelZoom = false, className }) {
  const [open, setOpen] = useState(false);
  const common = { spec, dirColorMap, ariaLabel: title };

  return (
    <div className={className}>
      {header && (
        <div className="mb-2 flex items-center justify-between gap-2">
          <p className="min-w-0 truncate text-cg-xs text-cg-tertiary">{header}</p>
          <Button size="sm" variant="ghost" onClick={() => setOpen(true)} leadingIcon={<Expand size={14} strokeWidth={1.5} aria-hidden="true" />}>
            Open full screen
          </Button>
        </div>
      )}
      <Suspense fallback={<DiagramSkeleton height={height} />}>
        <FlowDiagram
          {...common}
          height={height}
          wheelZoom={wheelZoom}
          onNodeClick={onNodeClick}
          onRequestFullscreen={header ? undefined : () => setOpen(true)}
        />
      </Suspense>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent title={title} className="h-[85dvh] w-[90vw] max-w-none" bodyClassName="flex min-h-0 flex-1 flex-col px-3 pb-3 pt-1">
          {open && (
            <Suspense fallback={<DiagramSkeleton height="100%" />}>
              <FlowDiagram
                {...common}
                height="100%"
                wheelZoom
                onNodeClick={(node) => {
                  setOpen(false);
                  onNodeClick?.(node);
                }}
              />
            </Suspense>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
