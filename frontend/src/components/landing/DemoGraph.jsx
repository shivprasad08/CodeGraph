// Landing-page demo graph. Loaded lazily (it pulls in react-force-graph-2d).
import { useEffect, useMemo, useRef, useState } from 'react';
import ForceGraph2D from 'react-force-graph-2d';
import { nodeDegrees, topNodeIdsByDegree } from '../../lib/graphStats';

const LABEL_COUNT = 20;
const TYPE_LABEL = { file: 'File', function: 'Function', class: 'Class' };

function readTokens() {
  const css = getComputedStyle(document.documentElement);
  const v = (name) => css.getPropertyValue(name).trim();
  return {
    file: v('--cg-node-file'),
    function: v('--cg-node-function'),
    class: v('--cg-node-class'),
    entry: v('--cg-node-entry'),
    text: v('--cg-text'),
    secondary: v('--cg-text-secondary'),
    font: v('--cg-font-sans'),
  };
}

const nodeKind = (n) => (n.is_entry_point && n.type !== 'file' ? 'entry' : n.type);

/** Overlay card for the hovered or tapped node. */
function NodeCard({ node, tokens }) {
  return (
    <div className="pointer-events-none absolute left-3 top-3 w-[min(300px,calc(100%-24px))] rounded-cg-panel border border-cg-border bg-cg-overlay p-3 font-cg-sans shadow-cg-edge">
      <p className="truncate text-cg-sm font-medium text-cg-text">{node.label}</p>
      <p className="mt-1 flex items-center gap-1.5 text-cg-xs text-cg-secondary">
        <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full" style={{ background: tokens[nodeKind(node)] }} />
        {TYPE_LABEL[node.type] ?? node.type}
        {node.is_entry_point && node.type !== 'file' ? ' · entry point' : ''}
      </p>
      {node.type !== 'file' && <p className="mt-1 truncate font-cg-mono text-cg-xs text-cg-tertiary">{node.file}</p>}
      {node.summary && <p className="mt-2 text-cg-xs text-cg-secondary">{node.summary}</p>}
    </div>
  );
}

/**
 * Static-layout interactive graph: layout is computed before first paint
 * (warmupTicks, cooldownTicks=0) so nothing animates. Zoom and pan are off so the
 * page scrolls normally; hover or tap a node to highlight its neighbours.
 */
export default function DemoGraph({ graph }) {
  const wrapRef = useRef(null);
  const fgRef = useRef(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [hovered, setHovered] = useState(null);
  const [pinned, setPinned] = useState(null);
  const tokens = useMemo(readTokens, []);
  const active = hovered ?? pinned;

  const { data, neighbours, labelIds, radius } = useMemo(() => {
    const degrees = nodeDegrees(graph.edges);
    const nb = new Map(graph.nodes.map((n) => [n.id, new Set()]));
    for (const e of graph.edges) {
      nb.get(e.source)?.add(e.target);
      nb.get(e.target)?.add(e.source);
    }
    return {
      data: {
        nodes: graph.nodes.map((n) => ({ ...n })),
        links: graph.edges.map((e) => ({ source: e.source, target: e.target })),
      },
      neighbours: nb,
      labelIds: topNodeIdsByDegree(graph, LABEL_COUNT),
      radius: (id) => 1.5 + Math.sqrt(degrees.get(id) ?? 0) * 0.55,
    };
  }, [graph]);

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

  const isLit = (id) => !active || id === active.id || neighbours.get(active.id)?.has(id);

  return (
    <div ref={wrapRef} className="absolute inset-0">
      {size.width > 0 && (
        <ForceGraph2D
          ref={fgRef}
          graphData={data}
          width={size.width}
          height={size.height}
          backgroundColor="rgba(0,0,0,0)"
          warmupTicks={160}
          cooldownTicks={0}
          onEngineStop={() => {
            // Fit the closest 95% of nodes so a few far-out nodes don't shrink the whole graph
            const pts = data.nodes.filter((n) => Number.isFinite(n.x));
            if (!pts.length) return;
            const cx = pts.reduce((s, n) => s + n.x, 0) / pts.length;
            const cy = pts.reduce((s, n) => s + n.y, 0) / pts.length;
            const dist = (n) => Math.hypot(n.x - cx, n.y - cy);
            const cutoff = pts.map(dist).sort((a, b) => a - b)[Math.floor(pts.length * 0.95)];
            fgRef.current?.zoomToFit(0, 24, (n) => dist(n) <= cutoff);
          }}
          enableZoomInteraction={false}
          enablePanInteraction={false}
          enableNodeDrag={false}
          nodeLabel={() => ''}
          nodeRelSize={1}
          nodeVal={(n) => radius(n.id) ** 2}
          linkColor={(l) => {
            if (!active) return 'rgba(237, 237, 239, 0.1)';
            const touches = l.source.id === active.id || l.target.id === active.id;
            return touches ? 'rgba(237, 237, 239, 0.55)' : 'rgba(237, 237, 239, 0.03)';
          }}
          linkWidth={(l) => (active && (l.source.id === active.id || l.target.id === active.id) ? 1 : 0.5)}
          nodeCanvasObject={(node, ctx, scale) => {
            const lit = isLit(node.id);
            const r = radius(node.id);
            ctx.globalAlpha = lit ? 1 : 0.12;
            ctx.beginPath();
            ctx.arc(node.x, node.y, r, 0, 2 * Math.PI);
            ctx.fillStyle = tokens[nodeKind(node)] || tokens.secondary;
            ctx.fill();
            if (active && node.id === active.id) {
              ctx.lineWidth = 1.5 / scale;
              ctx.strokeStyle = tokens.text;
              ctx.stroke();
            }
            const showLabel = active ? lit && (node.id === active.id || labelIds.has(node.id)) : labelIds.has(node.id);
            if (showLabel) {
              const fontSize = 11 / scale;
              ctx.font = `500 ${fontSize}px ${tokens.font}`;
              ctx.textAlign = 'center';
              ctx.textBaseline = 'top';
              ctx.fillStyle = node.id === active?.id ? tokens.text : tokens.secondary;
              ctx.fillText(node.label, node.x, node.y + r + 2 / scale);
            }
            ctx.globalAlpha = 1;
          }}
          nodePointerAreaPaint={(node, color, ctx) => {
            ctx.fillStyle = color;
            ctx.beginPath();
            ctx.arc(node.x, node.y, radius(node.id) + 3, 0, 2 * Math.PI);
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
        <NodeCard node={active} tokens={tokens} />
      ) : (
        <p className="pointer-events-none absolute bottom-3 right-3 text-cg-xs text-cg-tertiary">
          Hover or tap a node
        </p>
      )}
    </div>
  );
}
