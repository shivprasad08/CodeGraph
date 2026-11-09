import { useEffect, useState } from 'react';
import { Maximize2, Minus, Plus } from 'lucide-react';
import { formatCount, graphStats } from '../../lib/graphStats';
import { IconButton } from '../../ui';

/**
 * 32px bar under the canvas: graph counts on the left, zoom controls on the right.
 * `zoomListener` is a ref the parent forwards zoom changes to, so only this bar
 * re-renders while zooming.
 */
export default function StatusBar({ graph, zoomListener, onZoomIn, onZoomOut, onFit }) {
  const [zoom, setZoom] = useState(1);
  useEffect(() => {
    zoomListener.current = (k) => setZoom((prev) => (Math.round(prev * 100) === Math.round(k * 100) ? prev : k));
    return () => {
      zoomListener.current = null;
    };
  }, [zoomListener]);

  const s = graphStats(graph);
  const num = (n) => <span className="font-cg-mono">{formatCount(n)}</span>;
  const icon = { size: 14, strokeWidth: 1.5, 'aria-hidden': true };

  return (
    <div className="flex h-8 shrink-0 items-center justify-between gap-3 border-t border-cg-border bg-cg-raised pl-3 pr-1 font-cg-sans text-cg-xs text-cg-tertiary">
      <p className="min-w-0 truncate">
        <span className="hidden sm:inline">
          {num(s.files)} files ·{' '}
        </span>
        {num(s.nodes)} nodes<span className="hidden sm:inline"> · {num(s.edges)} edges</span>
      </p>
      <div className="flex shrink-0 items-center" role="group" aria-label="Zoom">
        <IconButton label="Zoom out" shortcut="−" size="sm" className="h-7 w-7" onClick={onZoomOut}>
          <Minus {...icon} />
        </IconButton>
        <span className="w-11 text-center font-cg-mono tabular-nums text-cg-secondary" aria-live="off" title="Zoom level">
          {Math.round(zoom * 100)}%
        </span>
        <IconButton label="Zoom in" shortcut="+" size="sm" className="h-7 w-7" onClick={onZoomIn}>
          <Plus {...icon} />
        </IconButton>
        <IconButton label="Fit graph to screen" shortcut="F" size="sm" className="h-7 w-7" onClick={onFit}>
          <Maximize2 {...icon} />
        </IconButton>
      </div>
    </div>
  );
}
