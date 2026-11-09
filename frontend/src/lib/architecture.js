// Deterministic module-level architecture from the code graph (no LLM).
//
// Modules are the second-level directories of the main package
// (src/miniredis/election → "election"). Top-level files in the package are their
// own module when they hold ≥3 functions/classes; smaller ones share the package
// module. scripts/ and tests/ are grouped and hidden unless asked for.

const HIDDEN_GROUPS = { scripts: 'scripts', script: 'scripts', bin: 'scripts', tests: 'tests', test: 'tests' };
const NOT_PACKAGES = new Set(['scripts', 'script', 'bin', 'tests', 'test', 'docs', 'doc', 'examples', 'example', 'benchmarks']);
const MIN_SYMBOLS_FOR_OWN_MODULE = 3;
export const MAX_EDGES = 20;
export const MIN_EDGE_WEIGHT = 2;

const fileOf = (node) => (node.type === 'file' ? node.id : node.file);
const stripPy = (name) => name.replace(/\.py$/, '');

/** Finds the main package directory ("src/miniredis", "flask", or "" for a flat repo). */
export function findPackageRoot(filePaths) {
  const counts = new Map();
  for (const p of filePaths) {
    const parts = p.split('/');
    if (parts.length < 2 || NOT_PACKAGES.has(parts[0])) continue;
    // src-layout: the package is the directory under src/
    const root = parts[0] === 'src' && parts.length > 2 ? `src/${parts[1]}` : parts[0];
    counts.set(root, (counts.get(root) ?? 0) + 1);
  }
  let best = '';
  let bestCount = 0;
  for (const [root, n] of counts) {
    if (n > bestCount) [best, bestCount] = [root, n];
  }
  return best;
}

/**
 * Assigns every file to a module.
 * @returns {Map<string, {id, label, hidden, files: string[]}>} keyed by module id
 */
export function groupModules(graph) {
  const nodes = graph?.nodes ?? [];
  const files = nodes.filter((n) => n.type === 'file').map((n) => n.id);
  const symbolsPerFile = new Map();
  for (const n of nodes) {
    if (n.type === 'function' || n.type === 'class') symbolsPerFile.set(n.file, (symbolsPerFile.get(n.file) ?? 0) + 1);
  }
  const root = findPackageRoot(files);
  const pkgName = root.split('/').pop() || 'root';
  const modules = new Map();
  const add = (id, label, hidden, file) => {
    if (!modules.has(id)) modules.set(id, { id, label, hidden, files: [] });
    modules.get(id).files.push(file);
  };

  for (const file of files) {
    const parts = file.split('/');
    if (root && file.startsWith(`${root}/`)) {
      const rel = file.slice(root.length + 1).split('/');
      if (rel.length > 1) add(`mod:${rel[0]}`, rel[0], false, file); // sub-package
      else if ((symbolsPerFile.get(file) ?? 0) >= MIN_SYMBOLS_FOR_OWN_MODULE) add(`mod:${stripPy(rel[0])}`, stripPy(rel[0]), false, file);
      else add(`mod:${pkgName}`, pkgName, false, file); // small top-level files share the package module
      continue;
    }
    const group = HIDDEN_GROUPS[parts[0]];
    if (group) add(`mod:${group}`, group, true, file);
    else if (parts[0] === 'src' && parts.length > 2) add(`mod:${parts[1]}`, parts[1], false, file); // another src/ package
    else if (parts.length > 1) add(`mod:${parts[0]}`, parts[0], false, file); // other top-level directories
    else if ((symbolsPerFile.get(file) ?? 0) >= MIN_SYMBOLS_FOR_OWN_MODULE) add(`mod:${stripPy(file)}`, stripPy(file), false, file);
    else add('mod:root', 'root files', false, file);
  }
  return modules;
}

/**
 * Builds a FlowDiagram spec of modules and the calls/imports between them.
 * @param {object} graph CodeGraph graph ({ nodes, edges })
 * @param {{ includeHidden?: boolean, maxEdges?: number, minWeight?: number }} [options]
 * @returns {{ direction, nodes, edges, hiddenCount }}
 */
export function buildArchitecture(graph, { includeHidden = false, maxEdges = MAX_EDGES, minWeight = MIN_EDGE_WEIGHT } = {}) {
  const nodes = graph?.nodes ?? [];
  const modules = groupModules(graph);
  const moduleOfFile = new Map();
  for (const m of modules.values()) for (const f of m.files) moduleOfFile.set(f, m);

  const byId = new Map(nodes.map((n) => [n.id, n]));
  const moduleOfNode = (id) => {
    const node = byId.get(typeof id === 'object' ? id.id : id);
    return node ? moduleOfFile.get(fileOf(node)) : undefined;
  };
  const visible = (m) => m && (includeHidden || !m.hidden);

  // Per-module stats
  const stats = new Map([...modules.keys()].map((id) => [id, { functions: 0, classes: 0, entry: false }]));
  for (const n of nodes) {
    const m = moduleOfFile.get(fileOf(n));
    if (!m) continue;
    const s = stats.get(m.id);
    if (n.type === 'function') s.functions += 1;
    if (n.type === 'class') s.classes += 1;
    if (n.is_entry_point && n.type !== 'file') s.entry = true;
  }

  // Aggregate calls + imports between different, visible modules
  const agg = new Map();
  for (const e of graph?.edges ?? []) {
    if (e.type !== 'calls' && e.type !== 'imports') continue;
    const a = moduleOfNode(e.source);
    const b = moduleOfNode(e.target);
    if (!visible(a) || !visible(b) || a.id === b.id) continue; // unknown targets and self-loops dropped
    const key = `${a.id}→${b.id}`;
    if (!agg.has(key)) agg.set(key, { source: a.id, target: b.id, calls: 0, imports: 0 });
    agg.get(key)[e.type === 'calls' ? 'calls' : 'imports'] += 1;
  }
  const edges = [...agg.values()]
    .map((e) => ({ ...e, weight: e.calls + e.imports }))
    .filter((e) => e.weight >= minWeight)
    .sort((x, y) => y.weight - x.weight || x.source.localeCompare(y.source) || x.target.localeCompare(y.target))
    .slice(0, maxEdges)
    .map((e) => ({
      id: `${e.source}→${e.target}`,
      source: e.source,
      target: e.target,
      weight: e.weight,
      label: e.calls ? `${e.calls} ${e.calls === 1 ? 'call' : 'calls'}` : `${e.imports} ${e.imports === 1 ? 'import' : 'imports'}`,
    }));

  const inDegree = new Map();
  for (const e of edges) inDegree.set(e.target, (inDegree.get(e.target) ?? 0) + e.weight);

  // Entry-point modules first, then by in-degree (leaf utilities end up last); dagre does the rest
  const shown = [...modules.values()].filter(visible);
  shown.sort(
    (a, b) =>
      Number(stats.get(b.id).entry) - Number(stats.get(a.id).entry) ||
      (inDegree.get(a.id) ?? 0) - (inDegree.get(b.id) ?? 0) ||
      a.label.localeCompare(b.label),
  );

  const specNodes = shown.map((m) => {
    const s = stats.get(m.id);
    // Representative file: the one with the most functions/classes
    const main = [...m.files].sort(
      (x, y) => nodes.filter((n) => n.file === y).length - nodes.filter((n) => n.file === x).length || x.localeCompare(y),
    )[0];
    const fileCount = m.files.length;
    return {
      id: m.id,
      label: m.label,
      sublabel: `${fileCount} ${fileCount === 1 ? 'file' : 'files'} · ${s.functions} ${s.functions === 1 ? 'function' : 'functions'}`,
      kind: 'module',
      nodeRef: main,
      cluster: main,
      members: m.files,
      entry: s.entry,
    };
  });

  return {
    direction: 'TB',
    nodes: specNodes,
    edges,
    hiddenCount: [...modules.values()].filter((m) => m.hidden).length,
  };
}

const ARCHITECTURE_INTENT = /architecture|overall structure|how is .* organi[sz]ed|high[- ]level|overview|components/i;

/** True when a chat question asks about the overall architecture. */
export const isArchitectureQuestion = (text = '') => ARCHITECTURE_INTENT.test(text);
