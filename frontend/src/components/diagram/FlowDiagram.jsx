// Diagram renderer (lazy-loaded: pulls in @xyflow/react and dagre).
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Expand, Maximize2 } from 'lucide-react';
import { Handle, MarkerType, Position, ReactFlow, ReactFlowProvider, useReactFlow, useStore } from '@xyflow/react';
import dagre from '@dagrejs/dagre';
import '@xyflow/react/dist/base.css';
import './diagram.css';
import { cn } from '../../lib/cn';
import { getDirectoryColor } from '../../utils/directoryColors';
import { IconButton } from '../../ui';

const NODE_W = 208;
const NODE_H = 56;
const NODE_H_NO_SUB = 40;
const RANKSEP = 72;
const NODESEP = 40;
const EDGESEP = 24;

/** Number of edges (by weight) whose label is always shown; the rest show on hover, focus or selection. */
export const ALWAYS_LABELLED = 8;
/** Minimum gap between two rendered labels; the lower-priority one is skipped. */
export const LABEL_GAP = 24;
const LABEL_FONT = 12;

const prefersReducedMotion = () => typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

function readTokens() {
  const css = getComputedStyle(document.documentElement);
  const v = (n) => css.getPropertyValue(n).trim();
  return {
    borderStrong: v('--cg-border-strong') || 'rgba(255,255,255,0.36)',
    canvas: v('--cg-canvas') || '#0A0A0B',
    text: v('--cg-text') || '#EDEDEF',
    secondary: v('--cg-text-secondary') || '#A1A1AA',
    tertiary: v('--cg-text-tertiary') || '#8B8B94',
  };
}

/** Approximate box of a rendered edge label (12px sans with 4px/2px padding), centred on (x, y). */
export function labelBox(text, x, y) {
  const w = String(text).length * LABEL_FONT * 0.55 + 8;
  const h = LABEL_FONT * 1.25 + 4;
  return { x1: x - w / 2, y1: y - h / 2, x2: x + w / 2, y2: y + h / 2 };
}

// Edge-to-edge distance between two boxes (negative when they overlap)
const gapBetween = (a, b) => Math.max(a.x1 - b.x2, b.x1 - a.x2, a.y1 - b.y2, b.y1 - a.y2);

/**
 * Picks which edge labels to render. Candidates go in priority order (active first, then
 * weight); a label closer than LABEL_GAP to one already accepted is skipped.
 * @param {Array<{id, label, weight, labelX, labelY}>} edges
 * @param {Set<string>} wanted ids that would like a label
 * @param {Set<string>} [active] ids that beat inactive ones
 * @returns {Set<string>} ids whose label is rendered
 */
export function pickLabels(edges, wanted, active = new Set()) {
  const order = edges
    .filter((e) => e.label && wanted.has(e.id))
    .sort((a, b) => Number(active.has(b.id)) - Number(active.has(a.id)) || b.weight - a.weight || a.id.localeCompare(b.id));
  const placed = [];
  const shown = new Set();
  for (const e of order) {
    const box = labelBox(e.label, e.labelX, e.labelY);
    if (placed.some((p) => gapBetween(p, box) < LABEL_GAP)) continue;
    placed.push(box);
    shown.add(e.id);
  }
  return shown;
}

/** Lays the spec out with dagre; returns positioned React Flow nodes and plain edge records. */
export function layoutSpec(spec) {
  const direction = spec.direction === 'LR' ? 'LR' : 'TB';
  const g = new dagre.graphlib.Graph();
  g.setGraph({ rankdir: direction, ranksep: RANKSEP, nodesep: NODESEP, edgesep: EDGESEP, marginx: 16, marginy: 16 });
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

  const vertical = direction === 'TB';
  const byId = new Map(spec.nodes.map((n) => [n.id, n]));
  // Handle points: bottom/top centre (TB) or right/left middle (LR). A bezier between them
  // has its t=0.5 point at the midpoint of the two, which is where React Flow puts the label.
  const anchor = (id, out) => {
    const p = positions.get(id);
    const h = heightOf(byId.get(id));
    return vertical ? { x: p.x + NODE_W / 2, y: out ? p.y + h : p.y } : { x: out ? p.x + NODE_W : p.x, y: p.y + h / 2 };
  };

  // Cluster dots: one palette slot per distinct cluster, same palette and assignment as the graph view
  const clusterKeys = [...new Set(spec.nodes.map((n) => n.cluster).filter(Boolean))];

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
    nodes: spec.nodes.map((n) => ({
      id: n.id,
      type: 'cg',
      position: positions.get(n.id),
      width: NODE_W,
      height: heightOf(n),
      ariaLabel: [n.label, n.sublabel].filter(Boolean).join(', '),
      data: {
        ...n,
        vertical,
        color: n.cluster ? getDirectoryColor(n.cluster, clusterKeys).token : null,
        clickable: Boolean(n.nodeRef || n.members),
      },
    })),
    edges: edges.map((e, i) => {
      const s = anchor(e.source, true);
      const t = anchor(e.target, false);
      return {
        id: e.id ?? `e${i}-${e.source}-${e.target}`,
        source: e.source,
        target: e.target,
        label: e.label ?? null,
        weight: e.weight ?? 1,
        labelX: (s.x + t.x) / 2,
        labelY: (s.y + t.y) / 2,
      };
    }),
  };
}

/**
 * Applies interaction state to a layout: which labels show (top N plus the active node's
 * or edge's, collision-free), edge widths and arrowheads, highlight and dimming.
 * @param {ReturnType<typeof layoutSpec>} layout
 * @param {{activeNodeId?: string|null, activeEdgeId?: string|null, tokens: object}} state
 */
export function decorate(layout, { activeNodeId = null, activeEdgeId = null, tokens }) {
  const weights = layout.edges.map((e) => e.weight);
  const minW = Math.min(...weights);
  const maxW = Math.max(...weights);
  const norm = (w) => (maxW > minW ? (w - minW) / (maxW - minW) : 0.5);
  const labelOf = new Map(layout.nodes.map((n) => [n.id, n.data.label ?? n.id]));

  const top = new Set(
    layout.edges
      .filter((e) => e.label)
      .sort((a, b) => b.weight - a.weight || a.id.localeCompare(b.id))
      .slice(0, ALWAYS_LABELLED)
      .map((e) => e.id),
  );
  const active = new Set(
    layout.edges
      .filter((e) => e.id === activeEdgeId || (activeNodeId && (e.source === activeNodeId || e.target === activeNodeId)))
      .map((e) => e.id),
  );
  const focusOn = Boolean(activeNodeId || activeEdgeId);
  const litNodes = new Set(activeNodeId ? [activeNodeId] : []);
  for (const e of layout.edges) if (active.has(e.id)) litNodes.add(e.source).add(e.target);

  const shown = pickLabels(layout.edges, new Set([...top, ...active]), active);

  return {
    nodes: layout.nodes.map((n) => ({ ...n, className: cn(focusOn && !litNodes.has(n.id) && 'cg-flow-dim') || undefined })),
    edges: layout.edges.map((e) => {
      const on = active.has(e.id);
      const width = Math.round((on ? 1.5 + norm(e.weight) : 1 + 2 * norm(e.weight)) * 100) / 100;
      const color = on ? tokens.text : tokens.borderStrong;
      const arrow = Math.round(6 + 3 * width); // 9–15px, proportional to the stroke
      const name = `${labelOf.get(e.source)} to ${labelOf.get(e.target)}`;
      return {
        id: e.id,
        source: e.source,
        target: e.target,
        type: 'default',
        label: shown.has(e.id) ? e.label : undefined,
        ariaLabel: e.label ? `${name}, ${e.label}` : name,
        data: { weight: e.weight },
        zIndex: on ? 1 : 0,
        className: cn(focusOn && !on && 'cg-flow-dim', on && 'cg-flow-active') || undefined,
        style: { stroke: color, strokeWidth: width },
        markerEnd: { type: MarkerType.ArrowClosed, color, width: arrow, height: arrow, markerUnits: 'userSpaceOnUse' },
        labelStyle: { fill: on ? tokens.text : tokens.secondary, fontSize: LABEL_FONT, fontFamily: 'var(--cg-font-sans)' },
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

const idOf = (target, selector) => target?.closest?.(selector)?.getAttribute('data-id') ?? null;

/**
 * Flow / architecture diagram.
 * @param {{direction?: 'TB'|'LR', nodes: Array<{id,label,sublabel?,kind?,nodeRef?,cluster?,members?}>, edges: Array<{source,target,label?,weight?}>}} props.spec
 * @param {(specNode) => void} [props.onNodeClick] Called for nodes with a nodeRef or members (click or Enter).
 * @param {number|string} [props.height=320]
 * @param {boolean} [props.wheelZoom=false] Scroll-wheel zoom; off where the diagram sits inside a scrolling panel.
 * @param {() => void} [props.onRequestFullscreen] Shows the "Open full screen" control.
 * @param {string} [props.ariaLabel]
 */
function FlowDiagramInner({ spec, onNodeClick, height = 320, wheelZoom = false, onRequestFullscreen, ariaLabel, className }) {
  const tokens = useMemo(readTokens, []);
  const layout = useMemo(() => layoutSpec(spec), [spec]);
  const bySpecId = useMemo(() => new Map(spec.nodes.map((n) => [n.id, n])), [spec]);

  // Pointer hover / keyboard focus win over the sticky click selection
  const [hoverNode, setHoverNode] = useState(null);
  const [focusNode, setFocusNode] = useState(null);
  const [selected, setSelected] = useState(null);
  const [hoverEdge, setHoverEdge] = useState(null);
  const [focusEdge, setFocusEdge] = useState(null);
  useEffect(() => setSelected(null), [spec]);

  const activeNodeId = hoverNode ?? focusNode ?? selected;
  const activeEdgeId = hoverEdge ?? focusEdge;
  const { nodes, edges } = useMemo(
    () => decorate(layout, { activeNodeId, activeEdgeId, tokens }),
    [layout, activeNodeId, activeEdgeId, tokens],
  );

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
        if (e.key === 'Escape') {
          setSelected(null);
          return;
        }
        if (e.key !== 'Enter' && e.key !== ' ') return;
        const id = idOf(e.target, '.react-flow__node');
        if (!id) return;
        e.preventDefault();
        setSelected(id);
        activate(id);
      }}
      onFocus={(e) => {
        setFocusNode(idOf(e.target, '.react-flow__node'));
        setFocusEdge(idOf(e.target, '.react-flow__edge'));
      }}
      onBlur={() => {
        setFocusNode(null);
        setFocusEdge(null);
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
        edgesFocusable
        zoomOnScroll={wheelZoom}
        preventScrolling={wheelZoom}
        zoomOnPinch
        zoomOnDoubleClick={false}
        panOnDrag
        onNodeMouseEnter={(_, node) => setHoverNode(node.id)}
        onNodeMouseLeave={() => setHoverNode(null)}
        onEdgeMouseEnter={(_, edge) => setHoverEdge(edge.id)}
        onEdgeMouseLeave={() => setHoverEdge(null)}
        onPaneClick={() => setSelected(null)}
        onNodeClick={(_, node) => {
          setSelected(node.id);
          activate(node.id);
        }}
      >
        <Controls onRequestFullscreen={onRequestFullscreen} focusBox={layout.focusBox} />
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
