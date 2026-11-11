// Architecture: the head commit's module diagram with the affected modules highlighted (others
// faded) and module dependencies new in this PR drawn dashed and labelled "new".
import { useMemo } from 'react';
import { Network } from 'lucide-react';
import { buildArchitecture } from '../../lib/architecture';
import DiagramFrame from '../diagram/DiagramFrame';

/** FlowDiagram spec for a PR result. Exported for tests. */
export function prArchitectureSpec(result) {
  const head = result.architecture?.head;
  if (!head?.modules?.length) return null;
  const spec = buildArchitecture({ nodes: result.subgraph?.nodes ?? [], architecture: head });
  if (spec.missing) return null;
  // Modules with code changes or impacted code (docs-only modules stay faded)
  const affected = new Map(result.modules.filter((m) => m.changed || m.impacted).map((m) => [m.label, m]));
  const idOf = new Map(head.modules.map((m) => [m.label, m.id]));
  const nodes = spec.nodes.map((n) => {
    const hit = affected.get(n.label);
    if (!hit) return { ...n, muted: true };
    const parts = [hit.changed && `${hit.changed} changed`, hit.impacted && `${hit.impacted} impacted`].filter(Boolean);
    return { ...n, highlight: true, sublabel: parts.join(' · ') || n.sublabel };
  });
  const edges = spec.edges.map((e) => ({ ...e }));
  for (const s of result.signals.filter((x) => x.kind === 'new_module_dependency')) {
    const source = idOf.get(s.source);
    const target = idOf.get(s.target);
    if (!source || !target) continue;
    const existing = edges.find((e) => e.source === source && e.target === target);
    if (existing) Object.assign(existing, { dashed: true, label: `new · ${existing.label}` });
    else edges.push({ id: `${source}→${target}`, source, target, weight: 1, label: 'new', dashed: true });
  }
  return { ...spec, nodes, edges };
}

export default function PRArchitectureTab({ result }) {
  const spec = useMemo(() => prArchitectureSpec(result), [result]);
  const newEdges = result.signals.filter((s) => s.kind === 'new_module_dependency');

  if (!spec || spec.nodes.length < 2) {
    return (
      <div className="flex flex-col items-center px-6 py-12 text-center">
        <Network size={24} strokeWidth={1.5} aria-hidden="true" className="text-cg-tertiary" />
        <p className="mt-3 max-w-sm text-cg-sm text-cg-secondary">This repository has too few modules for an architecture view.</p>
      </div>
    );
  }
  return (
    <div className="flex h-full min-h-[420px] flex-col gap-2">
      <DiagramFrame className="min-h-[360px] flex-1" spec={spec} title="Architecture affected by this PR" height="100%" wheelZoom />
      <p className="text-cg-xs text-cg-tertiary">
        Outlined: modules with changed or impacted code ({result.modules.filter((m) => m.changed || m.impacted).length}).{' '}
        {newEdges.length
          ? `Dashed: ${newEdges.length} module dependenc${newEdges.length === 1 ? 'y' : 'ies'} new in this PR.`
          : 'No new dependencies between modules.'}
      </p>
    </div>
  );
}
