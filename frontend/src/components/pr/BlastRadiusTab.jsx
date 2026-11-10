// Blast radius: the graph canvas limited to the changed code and everything that depends on it.
// Changed nodes get a 2px ring (added / modified / removed), impacted nodes are tinted by depth.
// "Show full graph" loads the head graph and dims everything else instead of hiding it.
import { useEffect, useMemo, useState } from 'react';
import { fetchPRGraph } from '../../api';
import { cn } from '../../lib/cn';
import { Spinner, focusRing } from '../../ui';
import SegmentedControl from '../../ui/SegmentedControl';
import GraphCanvas from '../GraphCanvas';
import { CHANGE_KIND, EmptyChanges } from './ChangesTab';

// Literal class names (Tailwind only generates classes it can see in the source)
const RING = { added: 'border-cg-success', modified: 'border-cg-sev-med', removed: 'border-cg-sev-high' };

const DEPTHS = [
  { value: '1', label: '1' },
  { value: '2', label: '2' },
  { value: '3', label: '3' },
  { value: 'all', label: 'All' },
];

/** The subgraph with impacted nodes beyond maxDepth (and edges to them) left out. */
export function limitDepth(subgraph, maxDepth) {
  const keep = new Set();
  for (const n of subgraph.nodes) {
    if (n.pr_change || (n.pr_depth && n.pr_depth <= maxDepth)) keep.add(n.id);
  }
  for (const n of subgraph.nodes) if (keep.has(n.id) && n.file) keep.add(n.file);
  return {
    ...subgraph,
    nodes: subgraph.nodes.filter((n) => keep.has(n.id)),
    edges: subgraph.edges.filter((e) => keep.has(e.source) && keep.has(e.target)),
  };
}

/** Full head graph plus the removed nodes (which only exist in the base graph). */
function withRemoved(full, subgraph) {
  const ids = new Set(full.nodes.map((n) => n.id));
  const extra = subgraph.nodes.filter((n) => !ids.has(n.id));
  const extraIds = new Set(extra.map((n) => n.id));
  return {
    ...full,
    nodes: [...full.nodes, ...extra],
    edges: [...full.edges, ...subgraph.edges.filter((e) => extraIds.has(e.source) || extraIds.has(e.target))],
  };
}

function Legend({ maxDepth }) {
  const depths = [1, 2, 3, 4].filter((d) => d <= maxDepth);
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-cg-xs text-cg-secondary">
      {Object.entries(CHANGE_KIND).map(([key, k]) => (
        <span key={key} className="inline-flex items-center gap-1.5">
          <span aria-hidden="true" className={cn('h-2.5 w-2.5 rounded-full border-2', RING[key])} />
          {k.label}
        </span>
      ))}
      <span className="inline-flex items-center gap-1.5">
        <span aria-hidden="true" className="flex gap-0.5">
          {depths.map((d) => (
            <span key={d} className="h-2 w-2 rounded-full bg-cg-text" style={{ opacity: [1, 0.95, 0.72, 0.52, 0.38][d] }} />
          ))}
        </span>
        Callers by depth (1 = direct)
      </span>
    </div>
  );
}

export default function BlastRadiusTab({ result, jobId, selectedId, onSelect, onShowFiles }) {
  const [depth, setDepth] = useState('all');
  const [full, setFull] = useState(false);
  const [fullGraph, setFullGraph] = useState(null);
  const [fullState, setFullState] = useState('idle'); // idle | loading | error
  const maxDepth = depth === 'all' ? 4 : Number(depth);
  const subgraph = result.subgraph;

  useEffect(() => {
    if (!full || fullGraph || !jobId) return;
    setFullState('loading');
    fetchPRGraph(jobId, 'head')
      .then((g) => {
        setFullGraph(withRemoved(g, subgraph));
        setFullState('idle');
      })
      .catch(() => setFullState('error'));
  }, [full, fullGraph, jobId, subgraph]);

  const shown = useMemo(() => {
    if (full && fullGraph) return fullGraph;
    return limitDepth(subgraph, maxDepth);
  }, [full, fullGraph, subgraph, maxDepth]);

  const overlay = useMemo(() => {
    const changes = new Map();
    const depths = new Map();
    for (const n of subgraph.nodes) {
      if (n.pr_change) changes.set(n.id, n.pr_change);
      else if (n.pr_depth && n.pr_depth <= maxDepth) depths.set(n.id, n.pr_depth);
    }
    return { changes, depths, dimOthers: Boolean(full && fullGraph) };
  }, [subgraph, maxDepth, full, fullGraph]);

  // Frame the selected node with its direct callers and callees, not the node alone
  const zoomTo = useMemo(() => {
    if (!selectedId) return null;
    const ids = new Set([selectedId]);
    for (const e of shown.edges) {
      if (e.type !== 'calls') continue;
      if (e.source === selectedId) ids.add(e.target);
      if (e.target === selectedId) ids.add(e.source);
    }
    return [...ids];
  }, [selectedId, shown]);
  const selected = selectedId ? subgraph.nodes.find((n) => n.id === selectedId) : null;
  const impacted = result.impacted.filter((i) => i.depth <= maxDepth);

  if (!result.changes.length) return <EmptyChanges onShowFiles={onShowFiles} />;

  return (
    <div className="flex h-full min-h-[420px] flex-col gap-3">
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex items-center gap-2">
          <span className="text-cg-xs text-cg-secondary">Depth</span>
          <SegmentedControl label="Caller depth" options={DEPTHS} value={depth} onChange={setDepth} className="shadow-none" />
        </div>
        <button
          type="button"
          aria-pressed={full}
          onClick={() => setFull((v) => !v)}
          className={cn(
            'inline-flex h-8 items-center gap-2 rounded-cg-control border px-2.5 text-cg-sm transition-colors duration-cg-fast ease-cg [@media(pointer:coarse)]:min-h-11',
            full ? 'border-cg-text text-cg-text' : 'border-cg-border-strong text-cg-secondary hover:text-cg-text',
            focusRing,
          )}
        >
          <span aria-hidden="true" className={cn('h-3 w-3 rounded-sm border', full ? 'border-cg-text bg-cg-text' : 'border-cg-border-strong')} />
          Show full graph
        </button>
        {fullState === 'loading' && <Spinner label="Loading the full graph" />}
        {fullState === 'error' && <span className="text-cg-xs text-cg-secondary">The full graph couldn&apos;t be loaded.</span>}
        <p className="ml-auto text-cg-xs text-cg-tertiary">
          {result.changes.length} changed · {impacted.length} impacted
          {result.impacted_capped ? ' (first 500)' : ''}
        </p>
      </div>

      <div className="relative min-h-[360px] flex-1 overflow-hidden rounded-cg-panel border border-cg-border bg-cg-canvas">
        <GraphCanvas
          graph={shown}
          onNodeClick={(node) => onSelect(node?.id ?? null)}
          selectedNodeId={selectedId}
          zoomToNodes={zoomTo}
          hullsVisible={false}
          prOverlay={overlay}
        />
      </div>

      <div className="flex flex-col gap-2 lg:flex-row lg:items-start lg:justify-between">
        <Legend maxDepth={maxDepth} />
        {selected && (
          <p className="min-w-0 text-cg-xs text-cg-secondary lg:max-w-[50%] lg:text-right" aria-live="polite">
            <span className="font-cg-mono text-cg-text">{selected.qualified_name || selected.label}</span>
            {selected.pr_change
              ? ` · ${CHANGE_KIND[selected.pr_change]?.label.toLowerCase()} in this PR`
              : selected.pr_depth
                ? ` · ${selected.pr_depth === 1 ? 'calls changed code directly' : `${selected.pr_depth} calls away from the change`}${selected.pr_exact === false ? ' (name-matched link)' : ''}`
                : ''}
          </p>
        )}
      </div>
    </div>
  );
}
