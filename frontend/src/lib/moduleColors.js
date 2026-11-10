// One colour per architecture module, shared by the graph canvas, the architecture view
// and the file tree, so a module looks the same everywhere.
//
// Colours come from the --cg-cluster-1…8 tokens. With more modules than colours, a colour
// is reused only by modules that are not directly linked (greedy graph colouring).
// Files outside every module (tests, scripts…) are neutral grey.

export const CLUSTER_COUNT = 8;
export const NEUTRAL = 'neutral';
export const clusterToken = (index) => `var(--cg-cluster-${index + 1})`;
export const NEUTRAL_TOKEN = 'var(--cg-text-tertiary)';

/**
 * Modules for graphs analysed before graph.architecture existed: the first folder below the
 * root, where the root descends into any folder holding more than 60% of the files
 * (scripts/ + src/miniredis/… → election, health, …) as the backend does.
 */
function fallbackModules(graph) {
  const files = (graph?.nodes ?? []).filter((n) => n.type === 'file').map((n) => n.id);
  if (!files.length) return [];
  const split = files.map((f) => f.split('/'));
  const groupAt = (root) => {
    const groups = new Map();
    for (const parts of split) {
      const inside = root.every((seg, i) => parts[i] === seg);
      const rest = inside ? parts.slice(root.length) : null;
      const key = rest && rest.length > 1 ? rest[0] : '(root)';
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(parts.join('/'));
    }
    return groups;
  };
  let root = [];
  let groups = groupAt(root);
  for (let depth = 0; depth < 4; depth += 1) {
    const dominant = [...groups].find(([key, members]) => key !== '(root)' && members.length > 0.6 * files.length);
    if (!dominant) break;
    root = [...root, dominant[0]];
    groups = groupAt(root);
  }
  return [...groups].map(([key, members]) => ({ id: `dir:${key}`, label: key, files: members }));
}

/**
 * Module colouring for a graph.
 * @returns {{ modules: Array<{id,label,files}>, colorIndex: Map<string, number>, moduleOfFile: Map<string, string> }}
 */
export function moduleColoring(graph) {
  const arch = graph?.architecture;
  const modules = arch?.modules?.length ? arch.modules : fallbackModules(graph);
  const moduleOfFile = new Map();
  for (const m of modules) for (const f of m.files ?? []) moduleOfFile.set(f, m.id);

  // Neighbours: architecture links, or (fallback) file-level calls/imports between modules
  const neighbours = new Map(modules.map((m) => [m.id, new Set()]));
  const link = (a, b) => {
    if (!a || !b || a === b || !neighbours.has(a) || !neighbours.has(b)) return;
    neighbours.get(a).add(b);
    neighbours.get(b).add(a);
  };
  if (arch?.edges?.length) {
    for (const e of arch.edges) link(e.source, e.target);
  } else {
    const fileOf = new Map((graph?.nodes ?? []).map((n) => [n.id, n.type === 'file' ? n.id : n.file]));
    for (const e of graph?.edges ?? []) {
      if (e.type !== 'calls' && e.type !== 'imports') continue;
      link(moduleOfFile.get(fileOf.get(idOf(e.source))), moduleOfFile.get(fileOf.get(idOf(e.target))));
    }
  }

  // Greedy: biggest modules first; the least-used colour no linked module has yet
  const order = [...modules].sort((a, b) => (b.files?.length ?? 0) - (a.files?.length ?? 0) || a.id.localeCompare(b.id));
  const colorIndex = new Map();
  const used = new Array(CLUSTER_COUNT).fill(0);
  for (const m of order) {
    const taken = new Set([...neighbours.get(m.id)].map((n) => colorIndex.get(n)).filter((c) => c !== undefined));
    let best = -1;
    for (let c = 0; c < CLUSTER_COUNT; c += 1) {
      if (taken.has(c)) continue;
      if (best === -1 || used[c] < used[best]) best = c;
    }
    if (best === -1) best = used.indexOf(Math.min(...used)); // linked to every colour: least used overall
    colorIndex.set(m.id, best);
    used[best] += 1;
  }
  return { modules, colorIndex, moduleOfFile };
}

const idOf = (end) => (typeof end === 'object' && end !== null ? end.id : end);

/** CSS colour (token) of the module a file belongs to; neutral for hidden / unknown files. */
export function fileColorToken(coloring, file) {
  const mid = coloring.moduleOfFile.get(file);
  return mid === undefined ? NEUTRAL_TOKEN : clusterToken(coloring.colorIndex.get(mid));
}
