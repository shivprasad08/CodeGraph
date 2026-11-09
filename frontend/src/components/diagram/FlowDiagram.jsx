// Diagram renderer (lazy-loaded: pulls in @xyflow/react and dagre).
import { useCallback, useEffect, useMemo } from 'react';
import { Expand, Maximize2 } from 'lucide-react';
import { Handle, MarkerType, Position, ReactFlow, ReactFlowProvider, useReactFlow, useStore } from '@xyflow/react';
import dagre from '@dagrejs/dagre';
import '@xyflow/react/dist/base.css';
import './diagram.css';
import { cn } from '../../lib/cn';
import { getTopLevelDir } from '../../utils/directoryColors';
import { IconButton } from '../../ui';

const NODE_W = 208;
const NODE_H = 56;
const NODE_H_NO_SUB = 40;
const RANKSEP = 56;
const NODESEP = 32;

const prefersReducedMotion = () => typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

function readTokens() {
  const css = getComputedStyle(document.documentElement);
  const v = (n) => css.getPropertyValue(n).trim();
  return {
    borderStrong: v('--cg-border-strong') || 'rgba(255,255,255,0.36)',
    canvas: v('--cg-canvas') || '#0A0A0B',
    secondary: v('--cg-text-secondary') || '#A1A1AA',
    tertiary: v('--cg-text-tertiary') || '#8B8B94',
  };
}

/** Lays the spec out with dagre and returns React Flow nodes/edges. */
export function layoutSpec(spec, { dirColorMap = {}, tokens } = {}) {
  const direction = spec.direction === 'LR' ? 'LR' : 'TB';
  const g = new dagre.graphlib.Graph();
  g.setGraph({ rankdir: direction, ranksep: RANKSEP, nodesep: NODESEP, marginx: 16, marginy: 16 });
  g.setDefaultEdgeLabel(() => ({}));
  const ids = new Set(spec.nodes.map((n) => n.id));
  const edges = spec.edges.filter((e) => ids.has(e.source) && ids.has(e.target) && e.source !== e.target);
  const linked = new Set(edges.flatMap((e) => [e.source, e.target]));
  const heightOf = (n) => (n.sublabel ? NODE_H : NODE_H_NO_SUB);

  // Linked nodes go through dagre. Unlinked ones would all land in one very wide
  // rank, so they get a compact grid under the layout instead.
  for (const n of spec.nodes) if (linked.has(n.id)) g.setNode(n.id, { width: NODE_W, height: heightOf(n) });
  for (const e of edges) g.setEdge(e.source, e.target);
  dagre.layout(g);

  const positions = new Map();
  let minX = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const id of linked) {
    const p = g.node(id);
    const pos = { x: p.x - p.width / 2, y: p.y - p.height / 2 };
    positions.set(id, pos);
    minX = Math.min(minX, pos.x);
    maxX = Math.max(maxX, pos.x + p.width);
    maxY = Math.max(maxY, pos.y + p.height);
  }
  const loose = spec.nodes.filter((n) => !linked.has(n.id));
  if (loose.length) {
    const startX = linked.size ? minX : 0;
    const startY = linked.size ? maxY + RANKSEP * 1.5 : 0;
    const fitCols = linked.size ? Math.floor((maxX - minX + NODESEP) / (NODE_W + NODESEP)) : 0;
    const cols = Math.max(3, Math.min(loose.length, fitCols || Math.ceil(Math.sqrt(loose.length))));
    loose.forEach((n, i) => {
      positions.set(n.id, {
        x: startX + (i % cols) * (NODE_W + NODESEP),
        y: startY + Math.floor(i / cols) * (NODE_H + NODESEP),
      });
    });
  }

  const maxWeight = Math.max(1, ...edges.map((e) => e.weight ?? 1));
  const vertical = direction === 'TB';

  // Initial fit frames the linked part (the interesting structure); unlinked nodes are a pan away
  const focus = linked.size >= 2 ? spec.nodes.filter((n) => linked.has(n.id)) : spec.nodes;
  const box = focus.reduce(
    (b, n) => {
      const p = positions.get(n.id);
      return {
        x1: Math.min(b.x1, p.x),
        y1: Math.min(b.y1, p.y),
        x2: Math.max(b.x2, p.x + NODE_W),
        y2: Math.max(b.y2, p.y + heightOf(n)),
      };
    },
    { x1: Infinity, y1: Infinity, x2: -Infinity, y2: -Infinity },
  );
  return {
    focusBox: focus.length ? box : null,
    nodes: spec.nodes.map((n) => {
      const pos = positions.get(n.id);
      const cluster = n.cluster ? dirColorMap[getTopLevelDir(n.cluster)] : null;
      return {
        id: n.id,
        type: 'cg',
        position: pos,
        width: NODE_W,
        height: heightOf(n),
        ariaLabel: [n.label, n.sublabel].filter(Boolean).join(', '),
        data: { ...n, vertical, color: cluster?.stroke ?? null, clickable: Boolean(n.nodeRef || n.members) },
      };
    }),
    edges: edges.map((e, i) => {
      const width = 1 + 1.5 * ((e.weight ?? 1) - 1) / Math.max(1, maxWeight - 1);
      return {
        id: e.id ?? `e${i}-${e.source}-${e.target}`,
        source: e.source,
        target: e.target,
        type: 'smoothstep',
        label: e.label,
        focusable: false,
        style: { stroke: tokens.borderStrong, strokeWidth: Math.min(2.5, Math.max(1, width)) },
        markerEnd: { type: MarkerType.ArrowClosed, color: tokens.borderStrong, width: 16, height: 16 },
        labelStyle: { fill: tokens.secondary, fontSize: 12, fontFamily: 'var(--cg-font-sans)' },
        labelBgStyle: { fill: tokens.canvas },
        labelBgPadding: [4, 2],
        labelBgBorderRadius: 4,
      };
    }),
  };
}

function DiagramNode({ data }) {
  return (
    <div
      className={cn(
        'flex h-full w-full flex-col justify-center rounded-cg-control border border-cg-border bg-cg-raised px-3 shadow-cg-edge',
        data.clickable && 'cursor-pointer transition-colors duration-cg-fast ease-cg hover:border-cg-border-strong hover:bg-cg-hover',
      )}
      title={data.nodeRef || data.label}
    >
      <Handle type="target" position={data.vertical ? Position.Top : Position.Left} isConnectable={false} />
      <div className="flex min-w-0 items-center gap-2">
        {data.color && <span aria-hidden="true" className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: data.color }} />}
        <span className="truncate text-cg-sm font-medium text-cg-text">{data.label}</span>
      </div>
      {data.sublabel && <span className="truncate font-cg-mono text-cg-xs text-cg-tertiary">{data.sublabel}</span>}
      <Handle type="source" position={data.vertical ? Position.Bottom : Position.Right} isConnectable={false} />
    </div>
  );
}

const NODE_TYPES = { cg: DiagramNode };

// Never fit below this zoom on first view: labels stay legible; the rest is a pan or "Fit diagram" away
const MIN_FIT_ZOOM = 0.65;
const MAX_FIT_ZOOM = 1.25;
const FIT_PADDING = 24;

function Controls({ onRequestFullscreen, focusBox }) {
  const { setViewport } = useReactFlow();
  const paneW = useStore((st) => st.width);
  const paneH = useStore((st) => st.height);

  const fit = useCallback(
    (minZoom, duration) => {
      if (!paneW || !paneH || !focusBox) return;
      const w = focusBox.x2 - focusBox.x1 + FIT_PADDING * 2;
      const h = focusBox.y2 - focusBox.y1 + FIT_PADDING * 2;
      const zoom = Math.max(minZoom, Math.min(MAX_FIT_ZOOM, paneW / w, paneH / h));
      const cx = (focusBox.x1 + focusBox.x2) / 2;
      const cy = (focusBox.y1 + focusBox.y2) / 2;
      setViewport({ x: paneW / 2 - cx * zoom, y: paneH / 2 - cy * zoom, zoom }, { duration });
    },
    [paneW, paneH, focusBox, setViewport],
  );

  // First fit as soon as the pane has a size (and again if it is resized)
  useEffect(() => fit(MIN_FIT_ZOOM, 0), [fit]);

  return (
    <div className="absolute right-2 top-2 z-10 flex gap-1">
      <IconButton label="Fit diagram" size="sm" variant="secondary" onClick={() => fit(0.2, prefersReducedMotion() ? 0 : 200)}>
        <Maximize2 size={14} strokeWidth={1.5} aria-hidden="true" />
      </IconButton>
      {onRequestFullscreen && (
        <IconButton label="Open full screen" size="sm" variant="secondary" onClick={onRequestFullscreen}>
          <Expand size={14} strokeWidth={1.5} aria-hidden="true" />
        </IconButton>
      )}
    </div>
  );
}

/**
 * Flow / architecture diagram.
 * @param {{direction?: 'TB'|'LR', nodes: Array<{id,label,sublabel?,kind?,nodeRef?,cluster?,members?}>, edges: Array<{source,target,label?,weight?}>}} props.spec
 * @param {(specNode) => void} [props.onNodeClick] Called for nodes with a nodeRef or members (click or Enter).
 * @param {object} [props.dirColorMap] Directory → cluster colour (for the node dot).
 * @param {number|string} [props.height=320]
 * @param {boolean} [props.wheelZoom=false] Scroll-wheel zoom; off where the diagram sits inside a scrolling panel.
 * @param {() => void} [props.onRequestFullscreen] Shows the "Open full screen" control.
 * @param {string} [props.ariaLabel]
 */
function FlowDiagramInner({ spec, onNodeClick, dirColorMap, height = 320, wheelZoom = false, onRequestFullscreen, ariaLabel, className }) {
  const tokens = useMemo(readTokens, []);
  const { nodes, edges, focusBox } = useMemo(() => layoutSpec(spec, { dirColorMap, tokens }), [spec, dirColorMap, tokens]);
  const bySpecId = useMemo(() => new Map(spec.nodes.map((n) => [n.id, n])), [spec]);

  const activate = useCallback(
    (id) => {
      const specNode = bySpecId.get(id);
      if (specNode && (specNode.nodeRef || specNode.members)) onNodeClick?.(specNode);
    },
    [bySpecId, onNodeClick],
  );

  return (
    <div
      role="group"
      aria-label={ariaLabel || 'Diagram'}
      className={cn('cg-flow relative w-full overflow-hidden rounded-cg-control border border-cg-border', className)}
      style={{ height }}
      onKeyDown={(e) => {
        if (e.key !== 'Enter' && e.key !== ' ') return;
        const el = e.target.closest?.('.react-flow__node');
        if (!el) return;
        e.preventDefault();
        activate(el.getAttribute('data-id'));
      }}
    >
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={NODE_TYPES}
        colorMode="dark"
        minZoom={0.2}
        maxZoom={2}
        nodesDraggable={false}
        nodesConnectable={false}
        elementsSelectable={false}
        nodesFocusable
        edgesFocusable={false}
        zoomOnScroll={wheelZoom}
        preventScrolling={wheelZoom}
        zoomOnPinch
        zoomOnDoubleClick={false}
        panOnDrag
        onNodeClick={(_, node) => activate(node.id)}
      >
        <Controls onRequestFullscreen={onRequestFullscreen} focusBox={focusBox} />
      </ReactFlow>
    </div>
  );
}

export default function FlowDiagram(props) {
  return (
    <ReactFlowProvider>
      <FlowDiagramInner {...props} />
    </ReactFlowProvider>
  );
}
