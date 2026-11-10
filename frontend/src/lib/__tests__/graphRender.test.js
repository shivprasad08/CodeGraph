import { describe, expect, it } from 'vitest';
import { buildArchitecture } from '../architecture';
import { CLUSTER_COUNT, NEUTRAL_TOKEN, clusterToken, fileColorToken, moduleColoring } from '../moduleColors';
import {
  MAX_RADIUS,
  buildAdjacency,
  computeDegrees,
  computeLayout,
  displayLabels,
  focusSet,
  isDunder,
  labelTier,
  nodeRadius,
  nodeShape,
  topLabelIds,
} from '../graphRender';

const file = (id) => ({ id, type: 'file' });
const fn = (f, name, extra = {}) => ({ id: `${f}::${name}`, label: name, type: 'function', file: f, ...extra });

function archGraph(moduleCount, links = []) {
  const modules = Array.from({ length: moduleCount }, (_, i) => ({
    id: `mod:m${i}`, label: `m${i}`, files: [`m${i}/a.py`], function_count: 1, class_count: 0, has_entry_points: false,
  }));
  return {
    nodes: [...modules.map((m) => file(m.files[0])), file('tests/test_x.py')],
    edges: [],
    architecture: {
      method: 'directories',
      modules,
      edges: links.map(([a, b]) => ({ source: `mod:m${a}`, target: `mod:m${b}`, calls: 3, imports: 0, weight: 3 })),
      hidden: ['tests/test_x.py'],
    },
  };
}

describe('module colours', () => {
  it('match the architecture view, and hidden files are neutral', () => {
    const graph = archGraph(3, [[0, 1]]);
    const coloring = moduleColoring(graph);
    const spec = buildArchitecture(graph);
    for (const node of spec.nodes) {
      expect(node.color).toBe(clusterToken(coloring.colorIndex.get(node.id)));
      expect(fileColorToken(coloring, node.members[0])).toBe(node.color);
    }
    expect(fileColorToken(coloring, 'tests/test_x.py')).toBe(NEUTRAL_TOKEN);
  });

  it('use every colour before reusing one, and never reuse one for linked modules', () => {
    const n = 14;
    const ring = Array.from({ length: n }, (_, i) => [i, (i + 1) % n]); // each module linked to two others
    const chords = [[0, 7], [3, 10], [5, 12]];
    const graph = archGraph(n, [...ring, ...chords]);
    const { colorIndex } = moduleColoring(graph);
    expect(new Set(colorIndex.values()).size).toBe(CLUSTER_COUNT);
    for (const [a, b] of [...ring, ...chords]) {
      expect(colorIndex.get(`mod:m${a}`)).not.toBe(colorIndex.get(`mod:m${b}`));
    }
  });

  it('fall back to the first folders below the main package for graphs without an architecture', () => {
    const graph = {
      nodes: [
        file('src/app/a/x.py'), file('src/app/a/y.py'), file('src/app/b/z.py'), file('src/app/c/w.py'), file('src/app/main.py'),
        file('scripts/run.py'),
      ],
      edges: [],
    };
    const { modules } = moduleColoring(graph);
    // src/ holds 5 of 6 files, src/app/ too: modules are its folders; the rest is "(root)"
    expect(modules.map((m) => m.label).sort()).toEqual(['(root)', 'a', 'b', 'c']);
  });
});

describe('node size and shape', () => {
  it('radius = 2.5 + √degree × 0.9, capped at 10', () => {
    expect(nodeRadius(0)).toBe(2.5);
    expect(nodeRadius(4)).toBeCloseTo(4.3);
    expect(nodeRadius(25)).toBeCloseTo(7);
    expect(nodeRadius(400)).toBe(MAX_RADIUS);
  });

  it('degree counts calls and imports, not "defines"', () => {
    const d = computeDegrees([
      { source: 'a', target: 'b', type: 'calls' },
      { source: 'a', target: 'c', type: 'imports' },
      { source: 'f', target: 'a', type: 'defines' },
    ]);
    expect(d.get('a')).toBe(2);
    expect(d.get('f')).toBeUndefined();
  });

  it('shape by type', () => {
    expect(nodeShape({ type: 'file' })).toBe('square');
    expect(nodeShape({ type: 'class' })).toBe('ring');
    expect(nodeShape({ type: 'function' })).toBe('dot');
    expect(nodeShape({ type: 'function', is_entry_point: true })).toBe('entry');
  });
});

describe('labels by zoom', () => {
  it.each([
    [0.3, 'modules'],
    [0.59, 'modules'],
    [0.6, 'top'],
    [1.5, 'top'],
    [1.51, 'all'],
    [4, 'all'],
  ])('zoom %s → %s', (zoom, tier) => {
    expect(labelTier(zoom)).toBe(tier);
  });
});

describe('focus mode', () => {
  it('is the node plus its direct neighbours, in either direction', () => {
    const adj = buildAdjacency([
      { source: 'a', target: 'b', type: 'calls' },
      { source: 'c', target: 'a', type: 'calls' },
      { source: 'b', target: 'd', type: 'calls' },
      { source: 'a', target: 'a', type: 'calls' },
    ]);
    expect([...focusSet(adj, 'a')].sort()).toEqual(['a', 'b', 'c']);
    expect([...focusSet(adj, 'd')].sort()).toEqual(['b', 'd']);
    expect(focusSet(adj, null)).toBeNull();
  });
});

describe('layout', () => {
  const nodes = () => {
    const out = [];
    for (const m of ['x', 'y', 'z']) for (let i = 0; i < 12; i += 1) out.push(fn(`${m}/f.py`, `${m}${i}`, { module: m }));
    return out;
  };
  const links = () => {
    const out = [];
    for (const m of ['x', 'y', 'z']) for (let i = 1; i < 12; i += 1) out.push({ source: `${m}/f.py::${m}0`, target: `${m}/f.py::${m}${i}`, type: 'calls' });
    out.push({ source: 'x/f.py::x1', target: 'y/f.py::y1', type: 'calls' });
    return out;
  };
  const moduleOf = (n) => (typeof n === 'object' ? n.module : n.split('/')[0]);

  it('is deterministic and keeps modules apart', () => {
    const a = nodes();
    const b = nodes();
    computeLayout(a, links(), moduleOf);
    computeLayout(b, links(), moduleOf);
    expect(a.map((n) => [n.x, n.y])).toEqual(b.map((n) => [n.x, n.y]));
    const centroid = (m) => {
      const pts = a.filter((n) => n.module === m);
      return { x: pts.reduce((s, n) => s + n.x, 0) / pts.length, y: pts.reduce((s, n) => s + n.y, 0) / pts.length };
    };
    const c = { x: centroid('x'), y: centroid('y'), z: centroid('z') };
    for (const n of a) {
      const own = Math.hypot(n.x - c[n.module].x, n.y - c[n.module].y);
      const others = Object.entries(c).filter(([m]) => m !== n.module).map(([, p]) => Math.hypot(n.x - p.x, n.y - p.y));
      expect(own).toBeLessThan(Math.min(...others));
    }
  });
});

describe('label rules', () => {
  const nodes = [
    file('src/store.py'),
    { id: 'src/store.py::Store', label: 'Store', type: 'class', file: 'src/store.py' },
    { id: 'src/store.py::Store.get', label: 'get', type: 'function', file: 'src/store.py', class_name: 'Store' },
    { id: 'src/cache.py::Cache.get', label: 'get', type: 'function', file: 'src/cache.py', class_name: 'Outer.Cache' },
    { id: 'src/cli.py::main', label: 'main', type: 'function', file: 'src/cli.py' },
    { id: 'src/server.py::main', label: 'main', type: 'function', file: 'src/server.py' },
    { id: 'src/store.py::Store.__init__', label: '__init__', type: 'function', file: 'src/store.py', class_name: 'Store' },
    { id: 'src/store.py::Store.__exit__', label: '__exit__', type: 'function', file: 'src/store.py', class_name: 'Store' },
    { id: 'src/util.py::slugify', label: 'slugify', type: 'function', file: 'src/util.py' },
  ];

  it('qualifies ambiguous names: Class.method for methods, file.func for functions', () => {
    const text = displayLabels(nodes);
    expect(text.get('src/store.py::Store.get')).toBe('Store.get');
    expect(text.get('src/cache.py::Cache.get')).toBe('Cache.get'); // innermost class
    expect(text.get('src/cli.py::main')).toBe('cli.main');
    expect(text.get('src/server.py::main')).toBe('server.main');
    expect(text.get('src/util.py::slugify')).toBe('slugify'); // unique: unchanged
    expect(text.get('src/store.py')).toBe('store.py');
  });

  it('never picks dunder methods for the mid-zoom labels', () => {
    const degree = { 'src/store.py::Store.__init__': 50, 'src/store.py::Store.__exit__': 40, 'src/util.py::slugify': 3 };
    const ids = topLabelIds(nodes, (n) => degree[n.id] ?? 0, 3);
    expect(ids.has('src/store.py::Store.__init__')).toBe(false);
    expect(ids.has('src/store.py::Store.__exit__')).toBe(false);
    expect(ids.has('src/util.py::slugify')).toBe(true);
    expect(isDunder('__init__') && isDunder('__exit__') && !isDunder('_private') && !isDunder('init')).toBe(true);
  });
});
