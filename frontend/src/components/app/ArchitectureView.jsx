import { useMemo, useState } from 'react';
import { Network, RotateCw } from 'lucide-react';
import { METHOD_LABEL, buildArchitecture } from '../../lib/architecture';
import { Button } from '../../ui';
import DiagramFrame from '../diagram/DiagramFrame';

/**
 * Canvas "Architecture" view: modules (grouped on the server, see graph.architecture)
 * and the calls/imports between them. Drawn over the force graph (which stays mounted).
 */
export default function ArchitectureView({ graph, dirColorMap, onNodeClick, onRerun, rerunning = false }) {
  const [includeHidden, setIncludeHidden] = useState(false);
  const spec = useMemo(() => buildArchitecture(graph, { includeHidden }), [graph, includeHidden]);

  if (spec.missing) {
    return (
      <div className="absolute inset-0 z-10 flex flex-col items-center justify-center bg-cg-canvas px-6 text-center">
        <Network size={24} strokeWidth={1.5} aria-hidden="true" className="text-cg-tertiary" />
        <h2 className="mt-3 text-cg-base font-medium text-cg-text">Re-run analysis to see the architecture view</h2>
        <p className="mt-1 max-w-sm text-cg-sm text-cg-secondary">
          This graph was analysed before modules were computed. The graph view still works.
        </p>
        {onRerun && (
          <Button
            size="sm"
            variant="secondary"
            className="mt-4"
            onClick={onRerun}
            disabled={rerunning}
            leadingIcon={<RotateCw size={16} strokeWidth={1.5} aria-hidden="true" />}
          >
            Re-run analysis
          </Button>
        )}
      </div>
    );
  }

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
          {METHOD_LABEL[spec.method] ?? 'Modules computed from the code graph'} · {spec.edges.length}{' '}
          {spec.edges.length === 1 ? 'link' : 'links'} · select a module to show it in the graph
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
