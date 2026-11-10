import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';
import ForceGraph2D from 'react-force-graph-2d';
import { computeConvexHull, expandHull, drawRoundedHull } from '../utils/hullUtils';
import { CLUSTER_COUNT, moduleColoring } from '../lib/moduleColors';
import {
  DIM_ALPHA,
  TOP_LABELS,
  buildAdjacency,
  computeDegrees,
  computeLayout,
  focusSet,
  labelTier,
  nodeRadius,
  nodeShape,
} from '../lib/graphRender';

// ---------------------------------------------------------------------------
// Colours (read once from the design tokens; pre-built strings so drawing allocates nothing)
// ---------------------------------------------------------------------------
const FADE_MS = 150;
const ALPHA_STEPS = 20; // dimming is quantised so every rgba() string is built once
const CALL_ALPHA = 0.08;
const IMPORT_ALPHA = 0.05;
const FOCUS_EDGE_ALPHA = 0.6;
const HULL_ALPHA = 0.03;
const NODE_FONT_PX = 11;
const MODULE_FONT_PX = 13;
const GRID_SPACING = 24;
const SEVERITY = { high: '--cg-sev-high', medium: '--cg-sev-med', low: '--cg-sev-low' };

function hexToRgb(value) {
  const v = value.trim();
  if (v.startsWith('#')) {
    const hex = v.length === 4 ? v.slice(1).split('').map((c) => c + c).join('') : v.slice(1, 7);
    return [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16));
  }
  const m = v.match(/\d+(\.\d+)?/g);
  return m ? m.slice(0, 3).map(Number) : [139, 139, 148];
}

function buildPalette() {
  const css = getComputedStyle(document.documentElement);
  const read = (name, fallback) => css.getPropertyValue(name).trim() || fallback;
  const fallbackClusters = ['#9d5ff0', '#60a5fa', '#4ade80', '#fbbf24', '#f472b6', '#2dd4bf', '#f87171', '#818cf8'];
  const swatch = (value) => {
    const [r, g, b] = hexToRgb(value);
    const rgba = (a) => `rgba(${r}, ${g}, ${b}, ${a})`;
    return {
      solid: `rgb(${r}, ${g}, ${b})`,
      calls: Array.from({ length: ALPHA_STEPS + 1 }, (_, i) => rgba(+(CALL_ALPHA * (i / ALPHA_STEPS)).toFixed(4))),
      imports: Array.from({ length: ALPHA_STEPS + 1 }, (_, i) => rgba(+(IMPORT_ALPHA * (i / ALPHA_STEPS)).toFixed(4))),
      focus: rgba(FOCUS_EDGE_ALPHA),
      hull: rgba(HULL_ALPHA),
    };
  };
  const clusters = Array.from({ length: CLUSTER_COUNT }, (_, i) => swatch(read(`--cg-cluster-${i + 1}`, fallbackClusters[i])));
  return {
    clusters,
    neutral: swatch(read('--cg-text-tertiary', '#8B8B94')),
    canvas: read('--cg-canvas', '#0A0A0B'),
    text: read('--cg-text', '#EDEDEF'),
    secondary: read('--cg-text-secondary', '#A1A1AA'),
    severity: Object.fromEntries(Object.entries(SEVERITY).map(([k, v]) => [k, read(v, '#8B8B94')])),
    mono: read('--cg-font-mono', 'monospace'),
    sans: read('--cg-font-sans', 'sans-serif'),
    grid: 'rgba(255, 255, 255, 0.04)',
  };
}

const prefersReducedMotion = () => typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
const coarsePointer = () => typeof window !== 'undefined' && !!window.matchMedia?.('(pointer: coarse)').matches;
const idOf = (end) => (typeof end === 'object' && end !== null ? end.id : end);

// Blast-radius simulation colours (unchanged behaviour)
const BLAST = { source: '#ffffff', critical: '#ef4444', high: '#f97316', medium: '#f59e0b', low: '#6b7280' };

// ---------------------------------------------------------------------------
// GraphCanvas
// ---------------------------------------------------------------------------
/**
 * Force-directed code graph. Ref API: zoomIn(), zoomOut(), zoomToFit(), getZoom().
 * Colour = architecture module (same as the architecture view); shape = node type;
 * size = degree; labels by zoom tier; hover/select focuses a node's neighbourhood.
 * The layout is computed off-screen before the first frame and then stays still.
 */
const GraphCanvas = forwardRef(function GraphCanvas(
  {
    graph,
    onNodeClick,
    selectedNodeId,
    highlightedNodeIds = new Set(),
    chatHighlightedNodeIds = new Set(),
    zoomToNodes,
    blastRadius = null,
    simulationMode = false,
    onExitSimulation,
    hullsVisible = true,
    onZoom,
  },
  ref,
) {
  const fgRef = useRef();
  const containerRef = useRef();
  const palette = useMemo(buildPalette, []);
  const [dimensions, setDimensions] = useState({ width: 0, height: 0 });
  const [layoutReady, setLayoutReady] = useState(false);
  const [animating, setAnimating] = useState(false);
  const [layoutMs, setLayoutMs] = useState(null);

  useImperativeHandle(ref, () => ({
    zoomIn: () => fgRef.current?.zoom(fgRef.current.zoom() * 1.4, 300),
    zoomOut: () => fgRef.current?.zoom(fgRef.current.zoom() / 1.4, 300),
    zoomToFit: () => fgRef.current?.zoomToFit(400, 40),
    getZoom: () => fgRef.current?.zoom() ?? 1,
  }), []);

  // -- Precomputed once per graph: modules, colours, degree, size, label priority -------
  const prepared = useMemo(() => {
    if (!graph?.nodes?.length) return null;
    const coloring = moduleColoring(graph);
    const degrees = computeDegrees(graph.edges ?? []);
    const fileOf = new Map(graph.nodes.map((n) => [n.id, n.type === 'file' ? n.id : n.file]));
    const moduleIds = coloring.modules.map((m) => m.id);
    const moduleIndexOf = new Map(moduleIds.map((id, i) => [id, i]));
    const nodes = graph.nodes.map((n) => {
      const moduleId = coloring.moduleOfFile.get(fileOf.get(n.id)) ?? null;
      const colorIndex = moduleId === null ? -1 : coloring.colorIndex.get(moduleId);
      const degree = degrees.get(n.id) ?? 0;
      const r = nodeRadius(degree);
      return {
        ...n,
        __module: moduleId,
        __moduleIndex: moduleId === null ? -1 : moduleIndexOf.get(moduleId),
        __color: colorIndex < 0 ? palette.neutral : palette.clusters[colorIndex],
        __degree: degree,
        __r: r,
        __shape: nodeShape(n),
        __text: n.type === 'file' ? n.id.split('/').pop() : n.label ?? '',
        __labelWidth: 0,
      };
    });
    const byId = new Map(nodes.map((n) => [n.id, n]));
    const links = (graph.edges ?? [])
      .filter((e) => byId.has(idOf(e.source)) && byId.has(idOf(e.target)))
      .map((e) => ({ ...e, source: idOf(e.source), target: idOf(e.target), __color: byId.get(idOf(e.source)).__color }));
    const ranked = [...nodes].sort((a, b) => b.__degree - a.__degree || a.id.localeCompare(b.id));
    ranked.forEach((n, i) => {
      n.__rank = i;
    });
    return {
      coloring,
      nodes,
      links,
      byId,
      ranked,
      adjacency: buildAdjacency(links),
      moduleLabels: coloring.modules.map((m) => ({
        label: m.label,
        color: moduleIndexOf.has(m.id) ? palette.clusters[coloring.colorIndex.get(m.id)] : palette.neutral,
        x: 0,
        y: 0,
        n: 0,
        hull: null,
      })),
      labelBoxes: new Float64Array(nodes.length * 4), // reused every frame for label collision
    };
  }, [graph, palette]);

  // -- Layout off-screen (after first paint, so "Laying out…" shows), then measure labels ----
  const [graphData, setGraphData] = useState({ nodes: [], links: [] });
  useEffect(() => {
    if (!prepared) return undefined;
    setLayoutReady(false);
    let cancelled = false;
    const handle = setTimeout(() => {
      const { nodes, links } = prepared;
      const moduleOf = (n) => (typeof n === 'object' ? n.__module : prepared.byId.get(n)?.__module) ?? null;
      const result = computeLayout(nodes, links.map((l) => ({ ...l })), moduleOf);
      if (cancelled) return;
      for (const n of nodes) {
        n.fx = n.x; // static: the force engine never moves anything after this
        n.fy = n.y;
      }
      // Label widths at 11px (one measureText per node; again once Geist Mono has loaded)
      const measureLabels = () => {
        const measure = document.createElement('canvas').getContext('2d');
        if (!measure) return;
        measure.font = `${NODE_FONT_PX}px ${palette.mono}`;
        for (const n of nodes) n.__labelWidth = measure.measureText(n.__text).width;
      };
      measureLabels();
      document.fonts?.ready.then(() => !cancelled && measureLabels());
      // Module centroids and hulls
      const points = prepared.moduleLabels.map(() => []);
      for (const n of nodes) {
        if (n.__moduleIndex < 0) continue;
        const m = prepared.moduleLabels[n.__moduleIndex];
        m.x += n.x;
        m.y += n.y;
        m.n += 1;
        points[n.__moduleIndex].push({ x: n.x, y: n.y });
      }
      prepared.moduleLabels.forEach((m, i) => {
        if (m.n) {
          m.x /= m.n;
          m.y /= m.n;
        }
        const hull = points[i].length >= 3 ? computeConvexHull(points[i]) : null;
        m.hull = hull && hull.length >= 3 ? expandHull(hull, 18) : null;
      });
      setLayoutMs(Math.round(result.ms));
      setGraphData({ nodes, links });
    }, 0);
    return () => {
      cancelled = true;
      clearTimeout(handle);
    };
  }, [prepared, palette]);

  // -- Interaction state lives in refs: hovering never re-renders React ---------------------
  const zoomRef = useRef({ k: 1, x: 0, y: 0 });
  const hoverRef = useRef(null);
  const selectedRef = useRef(selectedNodeId);
  const highlightRef = useRef(highlightedNodeIds);
  const chatRef = useRef(chatHighlightedNodeIds);
  const focusRef = useRef({ id: null, set: null, dim: 0, from: 0, to: 0, start: 0 });
  const fontCache = useRef({ k: 0, node: '', module: '' });
  const clickedRef = useRef(null); // a node clicked on the canvas: focus it, don't move the camera
  // force-graph re-tests hover every frame at the LAST pointer position, even after the pointer
  // left the canvas; while outside, hover is ignored (zooming would otherwise "hover" nodes)
  const pointerInside = useRef(false);

  const animationTimer = useRef(null);
  const updateFocus = useCallback(() => {
    if (!prepared) return;
    const id = hoverRef.current ?? selectedRef.current ?? null;
    const f = focusRef.current;
    const set = id ? focusSet(prepared.adjacency, id) : highlightRef.current.size ? highlightRef.current : null;
    const now = performance.now();
    const current = f.from + (f.to - f.from) * Math.min(1, (now - f.start) / FADE_MS);
    const target = set ? 1 : 0;
    if (set) {
      f.id = id;
      f.set = set;
    }
    if (target !== f.to) {
      f.from = prefersReducedMotion() ? target : current;
      f.to = target;
      f.start = now;
      setAnimating(true);
      clearTimeout(animationTimer.current);
      animationTimer.current = setTimeout(() => {
        if (!target) {
          f.id = null;
          f.set = null;
        }
        setAnimating(false);
      }, FADE_MS + 30);
    }
  }, [prepared]);

  useEffect(() => {
    highlightRef.current = highlightedNodeIds;
    updateFocus();
  }, [highlightedNodeIds, updateFocus]);
  useEffect(() => {
    chatRef.current = chatHighlightedNodeIds;
  }, [chatHighlightedNodeIds]);

  // Selection: focus, and zoom in when selected from outside the canvas
  useEffect(() => {
    selectedRef.current = selectedNodeId;
    updateFocus();
    const fromCanvas = selectedNodeId && selectedNodeId === clickedRef.current;
    clickedRef.current = null;
    if (selectedNodeId && !fromCanvas && fgRef.current && layoutReady) {
      const node = prepared?.byId.get(selectedNodeId);
      if (node && Number.isFinite(node.x)) {
        const reduced = prefersReducedMotion();
        fgRef.current.centerAt(node.x, node.y, reduced ? 0 : 600);
        fgRef.current.zoom(Math.max(fgRef.current.zoom(), 2.5), reduced ? 0 : 600);
      }
    }
  }, [selectedNodeId, prepared, layoutReady, updateFocus]);

  useEffect(() => {
    if (!zoomToNodes?.length || !fgRef.current || !layoutReady) return;
    const targets = zoomToNodes.map((id) => prepared?.byId.get(id)).filter(Boolean);
    if (targets.length === 1 && Number.isFinite(targets[0].x)) {
      fgRef.current.centerAt(targets[0].x, targets[0].y, 600);
      fgRef.current.zoom(Math.max(fgRef.current.zoom(), 2.5), 600);
    } else if (targets.length > 1) {
      fgRef.current.zoomToFit(400, 80, (n) => zoomToNodes.includes(n.id));
    }
  }, [zoomToNodes, prepared, layoutReady]);

  // Responsive size; re-fit (debounced) when the panel is resized
  const fitTimer = useRef(null);
  useEffect(() => {
    if (!containerRef.current) return undefined;
    const observer = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect;
      setDimensions({ width: Math.floor(width), height: Math.floor(height) });
      clearTimeout(fitTimer.current);
      fitTimer.current = setTimeout(() => {
        if (fgRef.current && !selectedRef.current) fgRef.current.zoomToFit(prefersReducedMotion() ? 0 : 250, 40);
      }, 200);
    });
    observer.observe(containerRef.current);
    return () => {
      observer.disconnect();
      clearTimeout(fitTimer.current);
    };
  }, []);

  // -- Per-frame helpers (read refs, allocate nothing) ----------------------------------------
  const dimAmount = () => {
    const f = focusRef.current;
    if (!f.set) return 0;
    const t = Math.min(1, (performance.now() - f.start) / FADE_MS);
    return f.from + (f.to - f.from) * t;
  };
  const isLit = (id, dim) => dim === 0 || focusRef.current.set?.has(id);

  const drawBackground = useCallback(
    (ctx, k) => {
      const { width, height } = dimensions;
      const z = zoomRef.current;
      // Faint dot grid in graph space (pans and zooms with the graph)
      let spacing = GRID_SPACING;
      while (spacing * k < 12) spacing *= 2;
      const x0 = Math.floor(-z.x / k / spacing) * spacing;
      const y0 = Math.floor(-z.y / k / spacing) * spacing;
      const x1 = (width - z.x) / k;
      const y1 = (height - z.y) / k;
      const dot = 1 / k;
      ctx.fillStyle = palette.grid;
      for (let x = x0; x <= x1; x += spacing) {
        for (let y = y0; y <= y1; y += spacing) ctx.fillRect(x, y, dot, dot);
      }
      if (!hullsVisible || !prepared || simulationMode) return;
      for (const m of prepared.moduleLabels) {
        if (!m.hull) continue;
        drawRoundedHull(ctx, m.hull, 14);
        ctx.fillStyle = m.color.hull;
        ctx.fill();
      }
    },
    [dimensions, palette, hullsVisible, prepared, simulationMode],
  );

  const nodeCanvasObject = useCallback(
    (node, ctx, k) => {
      if (!Number.isFinite(node.x)) return;
      const dim = simulationMode ? 0 : dimAmount();
      const lit = isLit(node.id, dim);
      let r = node.__r;
      let fill = node.__color.solid;
      if (simulationMode && blastRadius) {
        const hit = blastRadius.affected.get(node.id);
        fill = hit ? BLAST[hit.severity] ?? fill : palette.neutral.solid;
        ctx.globalAlpha = hit ? 1 : 0.15;
        if (hit?.severity === 'source') r *= 1.6;
      } else {
        ctx.globalAlpha = lit ? 1 : 1 - dim * (1 - DIM_ALPHA);
      }
      ctx.fillStyle = fill;
      ctx.strokeStyle = fill;
      ctx.beginPath();
      switch (node.__shape) {
        case 'square': {
          const s = r * 0.85;
          ctx.roundRect(node.x - s, node.y - s, s * 2, s * 2, s * 0.35);
          ctx.fill();
          break;
        }
        case 'ring':
          ctx.arc(node.x, node.y, r - 0.6, 0, 2 * Math.PI);
          ctx.lineWidth = 1.2;
          ctx.stroke();
          break;
        case 'entry':
          ctx.arc(node.x, node.y, r, 0, 2 * Math.PI);
          ctx.fill();
          ctx.beginPath();
          ctx.arc(node.x, node.y, r + 1.6, 0, 2 * Math.PI);
          ctx.lineWidth = 1 / k;
          ctx.stroke();
          break;
        default:
          ctx.arc(node.x, node.y, r, 0, 2 * Math.PI);
          ctx.fill();
      }
      if (chatRef.current?.has(node.id)) {
        ctx.beginPath();
        ctx.arc(node.x, node.y, r + 3, 0, 2 * Math.PI);
        ctx.strokeStyle = palette.secondary;
        ctx.lineWidth = 1 / k;
        ctx.stroke();
      }
      if (node.id === selectedRef.current) {
        ctx.beginPath();
        ctx.arc(node.x, node.y, r + 2.5, 0, 2 * Math.PI);
        ctx.strokeStyle = palette.text;
        ctx.lineWidth = 2 / k;
        ctx.stroke();
      }
      if (node.issue_count > 0 && k > 1.5 && palette.severity[node.issue_severity]) {
        ctx.beginPath();
        ctx.arc(node.x + r * 0.75, node.y - r * 0.75, 2.2 / Math.sqrt(k), 0, 2 * Math.PI);
        ctx.fillStyle = palette.severity[node.issue_severity];
        ctx.fill();
      }
      ctx.globalAlpha = 1;
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [palette, simulationMode, blastRadius],
  );

  const drawLabel = (ctx, node, k) => {
    const y = node.y + node.__r + 3 / k;
    ctx.strokeText(node.__text, node.x, y);
    ctx.fillText(node.__text, node.x, y);
  };

  const drawLabels = useCallback(
    (ctx, k) => {
      if (!prepared || !layoutReady) return;
      const fc = fontCache.current;
      if (fc.k !== k) {
        fc.k = k;
        fc.node = `${NODE_FONT_PX / k}px ${palette.mono}`;
        fc.module = `500 ${MODULE_FONT_PX / k}px ${palette.sans}`;
      }
      const dim = simulationMode ? 0 : dimAmount();
      const tier = labelTier(k);
      ctx.lineJoin = 'round';
      ctx.lineWidth = 3 / k;
      ctx.strokeStyle = palette.canvas;
      ctx.textAlign = 'center';

      if (tier === 'modules' && dim === 0) {
        ctx.font = fc.module;
        ctx.textBaseline = 'middle';
        ctx.fillStyle = palette.secondary;
        for (const m of prepared.moduleLabels) {
          if (!m.n) continue;
          ctx.strokeText(m.label, m.x, m.y);
          ctx.fillText(m.label, m.x, m.y);
        }
        return;
      }

      ctx.font = fc.node;
      ctx.textBaseline = 'top';
      ctx.fillStyle = palette.secondary;
      const focus = focusRef.current;
      if (dim > 0 && focus.set) {
        // Focus mode: the node and its neighbours, most connected first, without overlaps
        placeLabels(ctx, k, prepared, (n) => focus.set.has(n.id), focus.id);
        return;
      }
      if (tier === 'top') {
        placeLabels(ctx, k, prepared, (n) => n.__rank < TOP_LABELS, null);
        return;
      }
      const z = zoomRef.current;
      const x0 = -z.x / k;
      const y0 = -z.y / k;
      const x1 = (dimensions.width - z.x) / k;
      const y1 = (dimensions.height - z.y) / k;
      placeLabels(ctx, k, prepared, (n) => n.x >= x0 && n.x <= x1 && n.y >= y0 && n.y <= y1, null);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [prepared, layoutReady, palette, simulationMode, dimensions],
  );

  /** Labels in priority order; one overlapping a label already drawn is skipped. */
  function placeLabels(ctx, k, data, include, first) {
    const boxes = data.labelBoxes;
    let placed = 0;
    const h = (NODE_FONT_PX + 2) / k;
    const tryLabel = (n) => {
      const w = n.__labelWidth / k;
      const bx = n.x - w / 2;
      const by = n.y + n.__r + 3 / k;
      for (let i = 0; i < placed; i += 1) {
        const o = i * 4;
        if (bx < boxes[o + 2] && bx + w > boxes[o] && by < boxes[o + 3] && by + h > boxes[o + 1]) return;
      }
      const o = placed * 4;
      boxes[o] = bx;
      boxes[o + 1] = by;
      boxes[o + 2] = bx + w;
      boxes[o + 3] = by + h;
      placed += 1;
      drawLabel(ctx, n, k);
    };
    if (first) {
      const node = data.byId.get(first);
      if (node) {
        ctx.fillStyle = palette.text;
        tryLabel(node);
        ctx.fillStyle = palette.secondary;
      }
    }
    for (const n of data.ranked) if (n.id !== first && include(n)) tryLabel(n);
  }

  // -- Links ------------------------------------------------------------------------------
  const linkFocused = (link) => {
    const f = focusRef.current;
    if (!f.set || !f.id) return false;
    return link.source.id === f.id || link.target.id === f.id;
  };
  const linkColor = useCallback(
    (link) => {
      if (simulationMode && blastRadius) {
        const s = blastRadius.affected.get(link.source.id);
        const t = blastRadius.affected.get(link.target.id);
        if (s && t) return s.severity === 'critical' ? 'rgba(239,68,68,0.6)' : s.severity === 'high' ? 'rgba(249,115,22,0.5)' : 'rgba(245,158,11,0.4)';
        return 'rgba(255,255,255,0.03)';
      }
      const dim = dimAmount();
      if (dim > 0 && linkFocused(link)) return link.__color.focus;
      const step = Math.round((1 - dim * (1 - DIM_ALPHA)) * ALPHA_STEPS);
      return link.type === 'imports' ? link.__color.imports[step] : link.__color.calls[step];
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [simulationMode, blastRadius],
  );
  const linkWidth = useCallback(
    (link) => (simulationMode && blastRadius ? 1.5 : dimAmount() > 0 && linkFocused(link) ? 1 : 0.5),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [simulationMode, blastRadius],
  );
  const arrowLength = useCallback(
    (link) => (link.type === 'calls' && dimAmount() > 0 && linkFocused(link) ? 3 : 0),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );
  const lineDash = useCallback((link) => (link.confidence === 'inferred' ? [3, 3] : null), []);
  const linkVisible = useCallback((link) => link.type !== 'defines', []);
  // Slow particles on the selected node's outgoing calls (rebuilt only when the selection changes)
  const particles = useCallback(
    (link) => (selectedNodeId && !prefersReducedMotion() && link.type === 'calls' && idOf(link.source) === selectedNodeId ? 2 : 0),
    [selectedNodeId],
  );
  const particleColor = useCallback((link) => link.__color.solid, []);

  // -- Events --------------------------------------------------------------------------------
  const handleHover = useCallback(
    (node) => {
      if (coarsePointer()) return;
      if (node && !pointerInside.current) return;
      hoverRef.current = node ? node.id : null;
      if (containerRef.current) containerRef.current.style.cursor = node ? 'pointer' : 'default';
      updateFocus();
    },
    [updateFocus],
  );

  const onEngineStop = useCallback(() => {
    if (layoutReady || !graphData.nodes.length) return;
    fgRef.current?.zoomToFit(0, 40);
    setLayoutReady(true);
  }, [layoutReady, graphData]);

  const handleZoom = useCallback(
    (t) => {
      zoomRef.current = t;
      onZoom?.(t.k);
    },
    [onZoom],
  );

  const nodeVal = useCallback((n) => n.__r * n.__r, []);
  const noTooltip = useCallback(() => '', []);
  const replaceMode = useCallback(() => 'replace', []);
  const handleClick = useCallback(
    (node) => {
      clickedRef.current = node?.id ?? null;
      onNodeClick?.(node);
    },
    [onNodeClick],
  );
  const handleBackground = useCallback(() => onNodeClick?.(null), [onNodeClick]);

  const pointerArea = useCallback((node, color, ctx) => {
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(node.x, node.y, Math.max(node.__r + 1.5, 4), 0, 2 * Math.PI);
    ctx.fill();
  }, []);

  if (!graph || graph.nodes?.length === 0) {
    return (
      <div className="flex h-full w-full items-center justify-center p-6 text-center font-cg-sans text-cg-sm text-cg-tertiary">
        No nodes to display. The repo may be empty or unparseable.
      </div>
    );
  }

  return (
    <div
      ref={containerRef}
      className="relative h-full w-full"
      data-layout-ms={layoutMs ?? undefined}
      onPointerEnter={() => {
        pointerInside.current = true;
      }}
      onPointerLeave={() => {
        pointerInside.current = false;
        if (hoverRef.current) handleHover(null);
      }}
      onContextMenu={(e) => {
        e.preventDefault();
        fgRef.current?.zoomToFit(400, 40);
      }}
    >
      {dimensions.width > 0 && (
        <ForceGraph2D
          ref={fgRef}
          graphData={graphData}
          width={dimensions.width}
          height={dimensions.height}
          backgroundColor={palette.canvas}
          autoPauseRedraw={!animating}
          warmupTicks={0}
          cooldownTicks={0}
          onEngineStop={onEngineStop}
          enableNodeDrag={false}
          minZoom={0.05}
          onRenderFramePre={drawBackground}
          onRenderFramePost={drawLabels}
          nodeRelSize={1}
          nodeVal={nodeVal}
          nodeLabel={noTooltip}
          nodeCanvasObject={nodeCanvasObject}
          nodeCanvasObjectMode={replaceMode}
          nodePointerAreaPaint={pointerArea}
          linkVisibility={linkVisible}
          linkColor={linkColor}
          linkWidth={linkWidth}
          linkCurvature={0.15}
          linkLineDash={lineDash}
          linkDirectionalArrowLength={arrowLength}
          linkDirectionalArrowRelPos={1}
          linkDirectionalParticles={particles}
          linkDirectionalParticleSpeed={0.004}
          linkDirectionalParticleWidth={1.5}
          linkDirectionalParticleColor={particleColor}
          onNodeClick={handleClick}
          onNodeHover={handleHover}
          onBackgroundClick={handleBackground}
          onZoom={handleZoom}
        />
      )}

      {!layoutReady && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
          <p role="status" className="rounded-cg-control border border-cg-border bg-cg-overlay px-3 py-1.5 font-cg-sans text-cg-sm text-cg-secondary">
            Laying out the graph…
          </p>
        </div>
      )}

      {/* Simulation Overlay Stats */}
      {simulationMode && blastRadius && (
        <div className="absolute inset-x-3 bottom-3 z-20 flex flex-wrap items-center justify-between gap-x-4 gap-y-1 rounded-cg-control border border-cg-border bg-cg-overlay px-3 py-2 font-cg-sans text-cg-xs shadow-cg-edge">
          <p className="min-w-0 truncate text-cg-secondary">
            Simulating changes to{' '}
            <span className="font-cg-mono text-cg-text">
              {(() => {
                const srcEntry = [...blastRadius.affected.entries()].find(([, d]) => d.severity === 'source');
                const srcId = srcEntry ? srcEntry[0] : 'unknown';
                return graph?.nodes?.find((n) => n.id === srcId)?.label || srcId;
              })()}
            </span>
          </p>
          <p className="flex items-center gap-3 text-cg-secondary">
            {[
              ['critical', 'bg-cg-sev-high', blastRadius.stats.bySeverity.critical],
              ['high', 'bg-cg-sev-med', blastRadius.stats.bySeverity.high],
              ['medium', 'bg-cg-sev-low', blastRadius.stats.bySeverity.medium],
            ].map(([label, dot, n]) => (
              <span key={label} className="inline-flex items-center gap-1.5">
                <span aria-hidden="true" className={`h-1.5 w-1.5 rounded-full ${dot}`} />
                <span className="font-cg-mono text-cg-text">{n || 0}</span> {label}
              </span>
            ))}
            <span>
              <span className="font-cg-mono text-cg-text">{blastRadius.stats.total || 0}</span> total
            </span>
          </p>
          <button
            type="button"
            onClick={onExitSimulation}
            className="rounded px-1 text-cg-secondary transition-colors hover:text-cg-text focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cg-focus"
          >
            Exit simulation
          </button>
        </div>
      )}
    </div>
  );
});

export default GraphCanvas;
