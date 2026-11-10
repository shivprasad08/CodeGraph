// Pure helpers for the graph canvas and the landing demo graph: sizing, label tiers,
// focus neighbourhoods and the (off-screen) force layout. No React, no DOM.
import { forceLink, forceManyBody, forceSimulation, forceX, forceY } from 'd3-force-3d';

export const MAX_RADIUS = 10;
export const TOP_LABELS = 25;
export const MODULE_LABEL_MAX_ZOOM = 0.6; // below: module names only
export const ALL_LABELS_MIN_ZOOM = 1.5; // above: every label in view (collision-free)
export const DIM_ALPHA = 0.08; // nodes and edges outside the focus neighbourhood

const idOf = (end) => (typeof end === 'object' && end !== null ? end.id : end);

/** Calls + imports per node (structure, not "defines"). */
export function computeDegrees(edges) {
  const degree = new Map();
  for (const e of edges) {
    if (e.type !== 'calls' && e.type !== 'imports') continue;
    const s = idOf(e.source);
    const t = idOf(e.target);
    degree.set(s, (degree.get(s) ?? 0) + 1);
    degree.set(t, (degree.get(t) ?? 0) + 1);
  }
  return degree;
}

/** radius = 2.5 + √degree × 0.9, capped at 10 */
export const nodeRadius = (degree) => Math.min(MAX_RADIUS, 2.5 + Math.sqrt(degree) * 0.9);

/** Which labels a zoom level shows: "modules" | "top" | "all". */
export function labelTier(zoom) {
  if (zoom < MODULE_LABEL_MAX_ZOOM) return 'modules';
  if (zoom <= ALL_LABELS_MIN_ZOOM) return 'top';
  return 'all';
}

/** id → Set of directly linked ids (every edge type). */
export function buildAdjacency(edges) {
  const adj = new Map();
  const add = (a, b) => {
    if (!adj.has(a)) adj.set(a, new Set());
    adj.get(a).add(b);
  };
  for (const e of edges) {
    const s = idOf(e.source);
    const t = idOf(e.target);
    if (s === t) continue;
    add(s, t);
    add(t, s);
  }
  return adj;
}

/** The focused node and its direct neighbours. */
export function focusSet(adjacency, id) {
  if (!id) return null;
  const out = new Set([id]);
  for (const n of adjacency.get(id) ?? []) out.add(n);
  return out;
}

/** Shape a node is drawn with: "square" (file) | "ring" (class) | "dot" (function) | "entry". */
export function nodeShape(node) {
  if (node.type === 'file') return 'square';
  if (node.type === 'class') return 'ring';
  return node.is_entry_point ? 'entry' : 'dot';
}

// Deterministic jitter (so the same graph always gets the same layout)
function hash(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i += 1) h = Math.imul(h ^ str.charCodeAt(i), 16777619);
  return (h >>> 0) / 4294967295;
}

export const LAYOUT = {
  charge: -38,
  chargeDistanceMax: 360,
  linkInside: 22, // link distance inside a module
  linkAcross: 70, // …and across modules
  linkDefines: 10, // file → its own functions / classes
  modulePull: 0.12, // weak pull toward the module's centroid
  alphaDecay: 0.03,
  maxTicks: 400,
};

/**
 * Force layout computed synchronously, off-screen. Modules start on a circle and are
 * pulled (weakly) toward their own centroid; links inside a module are shorter than
 * links across modules, so modules separate.
 * @param {Array<{id}>} nodes  mutated: x, y set
 * @param {Array<{source,target,type}>} links
 * @param {(node) => string|null} moduleOf
 * @returns {{ ticks: number, ms: number }}
 */
export function computeLayout(nodes, links, moduleOf, options = LAYOUT) {
  const started = (typeof performance !== 'undefined' ? performance : Date).now();
  const moduleIds = [...new Set(nodes.map((n) => moduleOf(n) ?? '__none__'))].sort();
  const moduleIndex = new Map(moduleIds.map((m, i) => [m, i]));
  const nodeModule = new Int32Array(nodes.length);
  const ring = 45 * Math.sqrt(nodes.length);
  nodes.forEach((n, i) => {
    const mi = moduleIndex.get(moduleOf(n) ?? '__none__');
    nodeModule[i] = mi;
    const angle = (2 * Math.PI * mi) / Math.max(1, moduleIds.length);
    const spread = 25 + 6 * Math.sqrt(nodes.length / Math.max(1, moduleIds.length));
    n.x = Math.cos(angle) * ring + (hash(n.id) - 0.5) * spread;
    n.y = Math.sin(angle) * ring + (hash(`${n.id}#`) - 0.5) * spread;
  });
  const sameModule = (l) => moduleOf(l.source) !== null && moduleOf(l.source) === moduleOf(l.target);

  // Pull toward the module's current centroid (typed arrays: no allocation per tick)
  const count = new Float64Array(moduleIds.length);
  const sx = new Float64Array(moduleIds.length);
  const sy = new Float64Array(moduleIds.length);
  function moduleForce(alpha) {
    count.fill(0);
    sx.fill(0);
    sy.fill(0);
    for (let i = 0; i < nodes.length; i += 1) {
      const m = nodeModule[i];
      count[m] += 1;
      sx[m] += nodes[i].x;
      sy[m] += nodes[i].y;
    }
    const k = options.modulePull * alpha;
    for (let i = 0; i < nodes.length; i += 1) {
      const m = nodeModule[i];
      const n = nodes[i];
      n.vx += (sx[m] / count[m] - n.x) * k;
      n.vy += (sy[m] / count[m] - n.y) * k;
    }
  }

  const sim = forceSimulation(nodes, 2)
    .alphaDecay(options.alphaDecay)
    .force('charge', forceManyBody().strength(options.charge).distanceMax(options.chargeDistanceMax))
    .force(
      'link',
      forceLink(links)
        .id((d) => d.id)
        .distance((l) => (l.type === 'defines' ? options.linkDefines : sameModule(l) ? options.linkInside : options.linkAcross))
        .strength((l) => (l.type === 'defines' ? 0.9 : sameModule(l) ? 0.5 : 0.04)),
    )
    .force('module', moduleForce)
    .force('x', forceX(0).strength(0.02))
    .force('y', forceY(0).strength(0.02))
    .stop();
  let ticks = 0;
  while (ticks < options.maxTicks && sim.alpha() > sim.alphaMin()) {
    sim.tick();
    ticks += 1;
  }
  return { ticks, ms: (typeof performance !== 'undefined' ? performance : Date).now() - started };
}
