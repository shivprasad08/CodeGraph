import { useMemo } from 'react';
import { cn } from '../../lib/cn';
import { buildArchitecture } from '../../lib/architecture';
import { focusRing } from '../../ui';
import DiagramFrame from '../diagram/DiagramFrame';

const MAX_CHIPS = 10;
const CHAT_DIAGRAM_HEIGHT = 320;

const shortName = (id) => id.split('::').pop().split('/').pop();
const fileBase = (id) => (id.includes('::') ? id.split('::')[0] : id).split('/').pop();

/**
 * "Referenced" chips: deduped by id; when two labels collide the chip adds the
 * file ("start · node.py"). At most 10, then "+N more".
 */
export function ReferenceChips({ ids, onSelect }) {
  const unique = [...new Set(ids)];
  if (!unique.length) return null;
  const labelCount = new Map();
  for (const id of unique) labelCount.set(shortName(id), (labelCount.get(shortName(id)) ?? 0) + 1);
  const shown = unique.slice(0, MAX_CHIPS);
  return (
    <div className="mt-3 flex flex-wrap items-center gap-1.5">
      <span className="text-cg-xs text-cg-tertiary">Referenced</span>
      {shown.map((id) => (
        <button
          key={id}
          type="button"
          title={id}
          onClick={() => onSelect(id)}
          className={cn(
            'rounded border border-cg-border-strong px-1.5 py-0.5 font-cg-mono text-cg-xs text-cg-text',
            'transition-colors duration-cg-fast ease-cg hover:bg-cg-hover [@media(pointer:coarse)]:min-h-11',
            focusRing,
          )}
        >
          {shortName(id)}
          {labelCount.get(shortName(id)) > 1 && id.includes('::') && <span className="text-cg-tertiary"> · {fileBase(id)}</span>}
        </button>
      ))}
      {unique.length > MAX_CHIPS && <span className="text-cg-xs text-cg-tertiary">+{unique.length - MAX_CHIPS} more</span>}
    </div>
  );
}

/** Server-validated chat diagram → FlowDiagram spec (refs are known to exist). */
export function toFlowSpec(diagram, graph) {
  const byId = new Map((graph?.nodes ?? []).map((n) => [n.id, n]));
  return {
    direction: diagram.direction === 'LR' ? 'LR' : 'TB',
    nodes: diagram.nodes.map((n) => {
      const ref = byId.get(n.ref);
      const file = ref ? (ref.type === 'file' ? ref.id : ref.file) : n.ref;
      return { id: n.id, label: n.label, sublabel: file?.split('/').pop(), kind: ref?.type, nodeRef: n.ref, cluster: file };
    }),
    edges: diagram.edges.map((e, i) => ({ id: `chat-e${i}`, source: e.source, target: e.target, label: e.label })),
  };
}

/** Architecture card under an architecture question (computed from the graph, no LLM). */
export function ArchitectureCard({ graph, dirColorMap, onNodeClick }) {
  const spec = useMemo(() => buildArchitecture(graph), [graph]);
  if (spec.nodes.length < 2) return null;
  return (
    <DiagramFrame
      className="mt-4"
      spec={spec}
      title="Architecture"
      header="Architecture · computed from the code graph"
      height={CHAT_DIAGRAM_HEIGHT}
      dirColorMap={dirColorMap}
      onNodeClick={onNodeClick}
    />
  );
}

/** Flow card from the final chat event (already checked against the graph by the server). */
export function FlowCard({ diagram, graph, dirColorMap, onNodeClick }) {
  const spec = useMemo(() => toFlowSpec(diagram, graph), [diagram, graph]);
  return (
    <DiagramFrame
      className="mt-4"
      spec={spec}
      title="Flow"
      header="Flow · checked against the code graph"
      height={CHAT_DIAGRAM_HEIGHT}
      dirColorMap={dirColorMap}
      onNodeClick={onNodeClick}
    />
  );
}
