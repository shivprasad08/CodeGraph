// Landing-page demo graph. Loaded lazily (it pulls in react-force-graph-2d).
// Same visual language as the app canvas: colour = module, shape = type, size = degree.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import ForceGraph2D from 'react-force-graph-2d';
import { CLUSTER_COUNT, moduleColoring } from '../../lib/moduleColors';
import {
  buildAdjacency,
  computeDegrees,
  computeLayout,
  displayLabels,
  focusSet,
  nodeRadius,
  nodeShape,
  topLabelIds,
} from '../../lib/graphRender';
import { TypeShape } from '../app/GraphLegend';

const LABEL_COUNT = 20;
const TYPE_LABEL = { file: 'File', function: 'Function', class: 'Class' };

function readTokens() {
  const css = getComputedStyle(document.documentElement);
  const v = (name, fallback) => css.getPropertyValue(name).trim() || fallback;
  return {
    clusters: Array.from({ length: CLUSTER_COUNT }, (_, i) => v(`--cg-cluster-${i + 1}`, '#8B8B94')),
    neutral: v('--cg-text-tertiary', '#8B8B94'),
    canvas: v('--cg-canvas', '#0A0A0B'),
    text: v('--cg-text', '#EDEDEF'),
    secondary: v('--cg-text-secondary', '#A1A1AA'),
    mono: v('--cg-font-mono', 'monospace'),
  };
}

const withAlpha = (hex, alpha) => {
  const h = hex.replace('#', '');
  const n = parseInt(h.length === 3 ? h.split('').map((c) => c + c).join('') : h.slice(0, 6), 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
};

/** Overlay card for the hovered or tapped node. */
function NodeCard({ node }) {
  const kind = node.is_entry_point && node.type !== 'file' ? 'entry' : node.type;
  return (
    <div className="pointer-events-none absolute left-3 top-3 w-[min(300px,calc(100%-24px))] rounded-cg-panel border border-cg-border bg-cg-overlay p-3 font-cg-sans shadow-cg-edge">
      <p className="truncate text-cg-sm font-medium text-cg-text">{node.label}</p>
      <p className="mt-1 flex items-center gap-1.5 text-cg-xs text-cg-secondary">
        <TypeShape type={kind} />
        {TYPE_LABEL[node.type] ?? node.type}
        {node.is_entry_point && node.type !== 'file' ? ' · entry point' : ''}
      </p>
      {node.type !== 'file' && <p className="mt-1 truncate font-cg-mono text-cg-xs text-cg-tertiary">{node.file}</p>}
      {node.summary && <p className="mt-2 text-cg-xs text-cg-secondary">{node.summary}</p>}
    </div>
  );
}

/**
 * Static-layout interactive graph: the layout is computed before the first paint, so
 * nothing animates. Zoom and pan are off so the page scrolls normally; hover or tap a
 * node to focus its neighbours.
 */
export default function DemoGraph({ graph }) {
  const wrapRef = useRef(null);
  const fgRef = useRef(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [hovered, setHovered] = useState(null);
  const [pinned, setPinned] = useState(null);
  const tokens = useMemo(readTokens, []);
  const active = hovered ?? pinned;

  const prepared = useMemo(() => {
    const coloring = moduleColoring(graph);
    const degrees = computeDegrees(graph.edges);
    const fileOf = new Map(graph.nodes.map((n) => [n.id, n.type === 'file' ? n.id : n.file]));
    const nodes = graph.nodes.map((n) => {
      const mid = coloring.moduleOfFile.get(fileOf.get(n.id));
      const color = mid === undefined ? tokens.neutral : tokens.clusters[coloring.colorIndex.get(mid)];
      return { ...n, __module: mid ?? null, __color: color, __r: nodeRadius(degrees.get(n.id) ?? 0), __shape: nodeShape(n) };
    });
    // Layout uses every edge ("defines" keeps a function next to its file); drawing hides "defines"
    const links = graph.edges.map((e) => ({ source: e.source, target: e.target, type: e.type, confidence: e.confidence }));
    const byId = new Map(nodes.map((n) => [n.id, n]));
    computeLayout(nodes, links.map((l) => ({ ...l })), (n) => (typeof n === 'object' ? n.__module : byId.get(n)?.__module) ?? null);
    for (const n of nodes) {
      n.fx = n.x;
      n.fy = n.y;
    }
    for (const l of links) l.__edge = withAlpha(byId.get(l.source)?.__color ?? tokens.neutral, l.type === 'imports' ? 0.05 : 0.09);
    // Most connected nodes (never dunders); ambiguous names qualified as Class.method / file.func
    const labelIds = topLabelIds(nodes, (n) => degrees.get(n.id) ?? 0, LABEL_COUNT);
    const labelText = displayLabels(nodes);
    for (const n of nodes) n.__text = labelText.get(n.id) ?? n.label;
    const labelOrder = [...nodes].sort((a, b) => (degrees.get(b.id) ?? 0) - (degrees.get(a.id) ?? 0)).map((n) => n.id);
    return { data: { nodes, links }, adjacency: buildAdjacency(links), labelIds, labelOrder, byId };
  }, [graph, tokens]);

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return undefined;
    const observer = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect;
      setSize({ width: Math.floor(width), height: Math.floor(height) });
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const lit = useMemo(() => (active ? focusSet(prepared.adjacency, active.id) : null), [active, prepared]);

  const fit = useCallback(() => {
    // Fit the closest 95% of nodes so a few far-out nodes don't shrink the whole graph
    const pts = prepared.data.nodes;
    if (!pts.length) return;
    const cx = pts.reduce((s, n) => s + n.x, 0) / pts.length;
    const cy = pts.reduce((s, n) => s + n.y, 0) / pts.length;
    const dist = (n) => Math.hypot(n.x - cx, n.y - cy);
    const cutoff = pts.map(dist).sort((a, b) => a - b)[Math.floor(pts.length * 0.95)];
    fgRef.current?.zoomToFit(0, 24, (n) => dist(n) <= cutoff);
  }, [prepared]);

  return (
    <div ref={wrapRef} className="absolute inset-0">
      {size.width > 0 && (
        <ForceGraph2D
          ref={fgRef}
          graphData={prepared.data}
          width={size.width}
          height={size.height}
          backgroundColor="rgba(0,0,0,0)"
          warmupTicks={0}
          cooldownTicks={0}
          onEngineStop={fit}
          enableZoomInteraction={false}
          enablePanInteraction={false}
          enableNodeDrag={false}
          nodeLabel={() => ''}
          nodeRelSize={1}
          nodeVal={(n) => n.__r ** 2}
          linkCurvature={0.15}
          linkVisibility={(l) => l.type !== 'defines'}
          linkLineDash={(l) => (l.confidence === 'inferred' ? [3, 3] : null)}
          linkColor={(l) => {
            if (!lit) return l.__edge;
            const touches = l.source.id === active.id || l.target.id === active.id;
            return touches ? withAlpha(l.source.__color, 0.6) : 'rgba(237, 237, 239, 0.01)';
          }}
          linkWidth={(l) => (lit && (l.source.id === active.id || l.target.id === active.id) ? 1 : 0.5)}
          nodeCanvasObject={(node, ctx, scale) => {
            const on = !lit || lit.has(node.id);
            const r = node.__r;
            ctx.globalAlpha = on ? 1 : 0.08;
            ctx.fillStyle = node.__color;
            ctx.strokeStyle = node.__color;
            ctx.beginPath();
            if (node.__shape === 'square') {
              const s = r * 0.85;
              ctx.roundRect(node.x - s, node.y - s, s * 2, s * 2, s * 0.35);
              ctx.fill();
            } else if (node.__shape === 'ring') {
              ctx.arc(node.x, node.y, r - 0.6, 0, 2 * Math.PI);
              ctx.lineWidth = 1.2;
              ctx.stroke();
            } else {
              ctx.arc(node.x, node.y, r, 0, 2 * Math.PI);
              ctx.fill();
              if (node.__shape === 'entry') {
                ctx.beginPath();
                ctx.arc(node.x, node.y, r + 1.6, 0, 2 * Math.PI);
                ctx.lineWidth = 1 / scale;
                ctx.stroke();
              }
            }
            if (active && node.id === active.id) {
              ctx.beginPath();
              ctx.arc(node.x, node.y, r + 2.5, 0, 2 * Math.PI);
              ctx.lineWidth = 2 / scale;
              ctx.strokeStyle = tokens.text;
              ctx.stroke();
            }
            ctx.globalAlpha = 1;
          }}
          nodeCanvasObjectMode={() => 'replace'}
          onRenderFramePost={(ctx, scale) => {
            // Labels after all nodes, most connected first; one overlapping a drawn label is skipped
            ctx.font = `${11 / scale}px ${tokens.mono}`;
            ctx.textAlign = 'center';
            ctx.textBaseline = 'top';
            ctx.lineJoin = 'round';
            ctx.lineWidth = 3 / scale;
            ctx.strokeStyle = tokens.canvas;
            const placed = [];
            const h = 13 / scale;
            const candidates = lit
              ? [active.id, ...prepared.labelOrder.filter((id) => id !== active.id && lit.has(id) && prepared.labelIds.has(id))]
              : prepared.labelOrder.filter((id) => prepared.labelIds.has(id));
            for (const id of candidates) {
              const node = prepared.byId.get(id);
              if (!node || !Number.isFinite(node.x)) continue;
              const w = ctx.measureText(node.__text).width;
              const x0 = node.x - w / 2;
              const y0 = node.y + node.__r + 3 / scale;
              if (placed.some((b) => x0 < b[2] && x0 + w > b[0] && y0 < b[3] && y0 + h > b[1])) continue;
              placed.push([x0, y0, x0 + w, y0 + h]);
              ctx.fillStyle = id === active?.id ? tokens.text : tokens.secondary;
              ctx.strokeText(node.__text, node.x, y0);
              ctx.fillText(node.__text, node.x, y0);
            }
          }}
          nodePointerAreaPaint={(node, color, ctx) => {
            ctx.fillStyle = color;
            ctx.beginPath();
            ctx.arc(node.x, node.y, node.__r + 3, 0, 2 * Math.PI);
            ctx.fill();
          }}
          onNodeHover={(node) => {
            setHovered(node ?? null);
            if (wrapRef.current) wrapRef.current.style.cursor = node ? 'pointer' : 'default';
          }}
          onNodeClick={(node) => setPinned((p) => (p?.id === node.id ? null : node))}
          onBackgroundClick={() => setPinned(null)}
        />
      )}
      {active ? (
        <NodeCard node={active} />
      ) : (
        <p className="pointer-events-none absolute bottom-3 right-3 text-cg-xs text-cg-tertiary">Hover or tap a node</p>
      )}
    </div>
  );
}
