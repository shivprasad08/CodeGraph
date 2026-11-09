import { useMemo, useState } from 'react';
import { buildArchitecture, MAX_EDGES } from '../../lib/architecture';
import DiagramFrame from '../diagram/DiagramFrame';

/**
 * Canvas "Architecture" view: modules and the calls/imports between them,
 * computed from the code graph. Drawn over the force graph (which stays mounted).
 */
export default function ArchitectureView({ graph, dirColorMap, onNodeClick }) {
  const [includeHidden, setIncludeHidden] = useState(false);
  const spec = useMemo(() => buildArchitecture(graph, { includeHidden }), [graph, includeHidden]);

  return (
    <div className="absolute inset-0 z-10 flex flex-col bg-cg-canvas px-3 pb-3 pt-14">
      {spec.nodes.length < 2 ? (
        <p className="m-auto max-w-xs text-center text-cg-sm text-cg-tertiary">
          This repository has too few modules for an architecture view. Use the graph instead.
        </p>
      ) : (
        <DiagramFrame
          className="min-h-0 flex-1"
          spec={spec}
          title="Architecture"
          height="100%"
          wheelZoom
          dirColorMap={dirColorMap}
          onNodeClick={onNodeClick}
        />
      )}
      <div className="mt-2 flex flex-wrap items-center justify-between gap-x-4 gap-y-1 text-cg-xs text-cg-tertiary">
        <p>
          Modules computed from the code graph · strongest {Math.min(MAX_EDGES, spec.edges.length)} links · select a module to show it
          in the graph
        </p>
        {spec.hiddenCount > 0 && (
          <label className="inline-flex items-center gap-1.5 text-cg-secondary [@media(pointer:coarse)]:min-h-11">
            <input
              type="checkbox"
              checked={includeHidden}
              onChange={(e) => setIncludeHidden(e.target.checked)}
              className="h-3.5 w-3.5 accent-[var(--cg-text)]"
            />
            Include scripts and tests
          </label>
        )}
      </div>
    </div>
  );
}
