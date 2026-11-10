// Maps the backend's module grouping (graph.architecture, see backend/architecture.py)
// to a FlowDiagram spec. The grouping itself (directories / communities / hybrid) is
// computed once on the server and cached with the graph.

import { NEUTRAL_TOKEN, clusterToken, moduleColoring } from './moduleColors';

export const MIN_EDGE_WEIGHT = 2;
export const HIDDEN_MODULE_ID = 'mod:__hidden__';

const plural = (n, word) => `${n} ${n === 1 ? word : `${word}s`}`;
const idOf = (end) => (typeof end === 'object' && end !== null ? end.id : end);

/** Human description of how the modules were grouped. */
export const METHOD_LABEL = {
  directories: 'Grouped by directory',
  communities: 'Grouped by call and import communities',
  hybrid: 'Grouped by folder; files outside folders grouped by calls',
};

/**
 * Builds a FlowDiagram spec from graph.architecture.
 * @param {object} graph CodeGraph graph ({ nodes, edges, architecture })
 * @param {{ includeHidden?: boolean }} [options] Adds hidden files (tests, scripts…) as one module.
 * @returns {{ direction, nodes, edges, hiddenCount, method, missing }}
 */
export function buildArchitecture(graph, { includeHidden = false } = {}) {
  const arch = graph?.architecture;
  if (!arch || !Array.isArray(arch.modules)) {
    return { direction: 'TB', nodes: [], edges: [], groups: [], hiddenCount: 0, method: null, missing: true };
  }
  const nodes = graph.nodes ?? [];
  const hidden = arch.hidden ?? [];
  const modules = arch.modules.map((m) => ({ ...m }));
  let edges = (arch.edges ?? []).map((e) => ({ ...e }));

  if (includeHidden && hidden.length) {
    const hiddenSet = new Set(hidden);
    let functions = 0;
    let classes = 0;
    let entry = false;
    for (const n of nodes) {
      if (!hiddenSet.has(n.file)) continue;
      if (n.type === 'function') functions += 1;
      if (n.type === 'class') classes += 1;
      if (n.is_entry_point && n.type !== 'file') entry = true;
    }
    modules.push({
      id: HIDDEN_MODULE_ID,
      label: 'scripts and tests',
      files: [...hidden],
      function_count: functions,
      class_count: classes,
      has_entry_points: entry,
    });
    edges = edges.concat(hiddenModuleEdges(graph, modules, hiddenSet));
  }

  // Representative file per module (most functions/classes): opened when the module is selected
  const symbols = new Map();
  for (const n of nodes) if (n.type === 'function' || n.type === 'class') symbols.set(n.file, (symbols.get(n.file) ?? 0) + 1);
  const mainFile = (files) => [...files].sort((x, y) => (symbols.get(y) ?? 0) - (symbols.get(x) ?? 0) || x.localeCompare(y))[0];

  const inDegree = new Map();
  for (const e of edges) inDegree.set(e.target, (inDegree.get(e.target) ?? 0) + e.weight);
  // Entry-point modules first, then by in-degree (leaf utilities end up last); dagre does the rest
  modules.sort(
    (a, b) =>
      Number(b.has_entry_points) - Number(a.has_entry_points) ||
      (inDegree.get(a.id) ?? 0) - (inDegree.get(b.id) ?? 0) ||
      a.label.localeCompare(b.label),
  );

  // Module colours: the same mapping the graph canvas and file tree use
  const coloring = moduleColoring(graph);
  const colorOf = (id) => (coloring.colorIndex.has(id) ? clusterToken(coloring.colorIndex.get(id)) : NEUTRAL_TOKEN);

  return {
    direction: 'TB',
    method: arch.method ?? null,
    missing: false,
    // Multi-app repos: containers drawn as frames around their modules (node.group)
    groups: (arch.groups ?? []).map((g) => ({ id: g.id, label: g.label })),
    hiddenCount: hidden.length,
    nodes: modules.map((m) => {
      const main = mainFile(m.files);
      return {
        id: m.id,
        label: m.label,
        sublabel: `${plural(m.files.length, 'file')} · ${plural(m.function_count, 'function')}`,
        kind: 'module',
        nodeRef: main,
        cluster: main,
        members: m.files,
        entry: m.has_entry_points,
        group: m.parent ?? null,
        color: colorOf(m.id),
      };
    }),
    edges: edges.map((e) => ({
      id: `${e.source}→${e.target}`,
      source: e.source,
      target: e.target,
      weight: e.weight,
      label: e.calls ? plural(e.calls, 'call') : plural(e.imports, 'import'),
    })),
  };
}

/** Calls/imports between the hidden-files module and the others (weight ≥ MIN_EDGE_WEIGHT). */
function hiddenModuleEdges(graph, modules, hiddenSet) {
  const moduleOfFile = new Map();
  for (const m of modules) for (const f of m.files) moduleOfFile.set(f, m.id);
  const fileOf = new Map((graph.nodes ?? []).map((n) => [n.id, n.type === 'file' ? n.id : n.file]));
  const agg = new Map();
  for (const e of graph.edges ?? []) {
    if (e.type !== 'calls' && e.type !== 'imports') continue;
    const fa = fileOf.get(idOf(e.source));
    const fb = fileOf.get(idOf(e.target));
    if (!fa || !fb || (!hiddenSet.has(fa) && !hiddenSet.has(fb))) continue;
    const a = moduleOfFile.get(fa);
    const b = moduleOfFile.get(fb);
    if (!a || !b || a === b) continue;
    const key = `${a}→${b}`;
    if (!agg.has(key)) agg.set(key, { source: a, target: b, calls: 0, imports: 0, weight: 0 });
    const row = agg.get(key);
    row[e.type === 'calls' ? 'calls' : 'imports'] += 1;
    row.weight += 1;
  }
  return [...agg.values()]
    .filter((e) => e.weight >= MIN_EDGE_WEIGHT)
    .sort((x, y) => y.weight - x.weight || x.source.localeCompare(y.source) || x.target.localeCompare(y.target));
}

const ARCHITECTURE_INTENT = /architecture|overall structure|how is .* organi[sz]ed|high[- ]level|overview|components/i;

/** True when a chat question asks about the overall architecture. */
export const isArchitectureQuestion = (text = '') => ARCHITECTURE_INTENT.test(text);
