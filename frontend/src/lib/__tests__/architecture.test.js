import { describe, expect, it } from 'vitest';
import { buildArchitecture, findPackageRoot, groupModules, isArchitectureQuestion } from '../architecture';

// src/app package with two sub-packages, two top-level files (one big, one small),
// plus scripts/ and tests/.
const file = (id) => ({ id, type: 'file' });
const fn = (file, name, extra = {}) => ({ id: `${file}::${name}`, label: name, type: 'function', file, ...extra });

const nodes = [
  file('src/app/api/routes.py'),
  file('src/app/api/auth.py'),
  file('src/app/db/models.py'),
  file('src/app/server.py'),
  file('src/app/version.py'),
  file('scripts/seed.py'),
  file('tests/test_api.py'),
  fn('src/app/api/routes.py', 'index', { is_entry_point: true }),
  fn('src/app/api/routes.py', 'login'),
  fn('src/app/api/auth.py', 'check'),
  fn('src/app/db/models.py', 'save'),
  fn('src/app/db/models.py', 'load'),
  fn('src/app/server.py', 'run'),
  fn('src/app/server.py', 'stop'),
  fn('src/app/server.py', 'serve'),
  fn('src/app/version.py', 'get_version'),
  fn('scripts/seed.py', 'seed'),
  fn('tests/test_api.py', 'test_index'),
];

const call = (s, t) => ({ source: s, target: t, type: 'calls' });
const edges = [
  // api → db: 3 calls + 1 import (weight 4)
  call('src/app/api/routes.py::index', 'src/app/db/models.py::load'),
  call('src/app/api/routes.py::login', 'src/app/db/models.py::save'),
  call('src/app/api/auth.py::check', 'src/app/db/models.py::load'),
  { source: 'src/app/api/routes.py', target: 'src/app/db/models.py', type: 'imports' },
  // server → api: 2 calls
  call('src/app/server.py::run', 'src/app/api/routes.py::index'),
  call('src/app/server.py::serve', 'src/app/api/routes.py::login'),
  // api → app (version.py, small file): 1 call → below the weight cut
  call('src/app/api/routes.py::index', 'src/app/version.py::get_version'),
  // self-loops inside api
  call('src/app/api/routes.py::login', 'src/app/api/auth.py::check'),
  call('src/app/api/routes.py::index', 'src/app/api/auth.py::check'),
  // scripts/tests → app (hidden by default)
  call('scripts/seed.py::seed', 'src/app/db/models.py::save'),
  call('scripts/seed.py::seed', 'src/app/db/models.py::load'),
  call('tests/test_api.py::test_index', 'src/app/api/routes.py::index'),
  call('tests/test_api.py::test_index', 'src/app/api/routes.py::login'),
  // edge to a node that is not in the graph (external) is ignored
  call('src/app/server.py::run', 'os::getenv'),
  // "defines" edges never count
  { source: 'src/app/db/models.py', target: 'src/app/db/models.py::save', type: 'defines' },
];
const graph = { nodes, edges };

describe('module grouping', () => {
  it('finds the package root, including src-layout', () => {
    expect(findPackageRoot(nodes.filter((n) => n.type === 'file').map((n) => n.id))).toBe('src/app');
    expect(findPackageRoot(['flask/app.py', 'flask/cli.py', 'docs/conf.py', 'tests/test_x.py'])).toBe('flask');
    expect(findPackageRoot(['main.py', 'util.py'])).toBe('');
  });

  it('uses sub-packages, gives big top-level files their own module, and groups scripts/tests', () => {
    const modules = groupModules(graph);
    const summary = Object.fromEntries([...modules.values()].map((m) => [m.label, { files: m.files.length, hidden: m.hidden }]));
    expect(summary).toEqual({
      api: { files: 2, hidden: false },
      db: { files: 1, hidden: false },
      server: { files: 1, hidden: false }, // 3 functions → own module
      app: { files: 1, hidden: false }, // version.py has 1 function → package module
      scripts: { files: 1, hidden: true },
      tests: { files: 1, hidden: true },
    });
  });
});

describe('buildArchitecture', () => {
  it('aggregates calls + imports between modules, drops self-loops and weak edges', () => {
    const arch = buildArchitecture(graph);
    expect(arch.edges.map((e) => [e.source, e.target, e.weight, e.label])).toEqual([
      ['mod:api', 'mod:db', 4, '3 calls'],
      ['mod:server', 'mod:api', 2, '2 calls'],
    ]);
    expect(arch.edges.some((e) => e.source === e.target)).toBe(false);
  });

  it('hides scripts and tests by default and can include them', () => {
    const arch = buildArchitecture(graph);
    expect(arch.nodes.map((n) => n.label)).not.toContain('scripts');
    expect(arch.hiddenCount).toBe(2);

    const all = buildArchitecture(graph, { includeHidden: true });
    expect(all.nodes.map((n) => n.label)).toEqual(expect.arrayContaining(['scripts', 'tests']));
    expect(all.edges.map((e) => `${e.source}→${e.target}`)).toEqual(
      expect.arrayContaining(['mod:scripts→mod:db', 'mod:tests→mod:api']),
    );
  });

  it('keeps only the top N edges by weight', () => {
    const many = { nodes: [...nodes], edges: [...edges] };
    // 25 extra modules, each calling db 2..26 times
    for (let i = 0; i < 25; i++) {
      many.nodes.push(file(`src/app/m${i}/x.py`));
      for (let k = 0; k < 2 + i; k++) {
        many.nodes.push(fn(`src/app/m${i}/x.py`, `f${k}`));
        many.edges.push(call(`src/app/m${i}/x.py::f${k}`, 'src/app/db/models.py::save'));
      }
    }
    const arch = buildArchitecture(many);
    expect(arch.edges).toHaveLength(20);
    const weights = arch.edges.map((e) => e.weight);
    expect(weights).toEqual([...weights].sort((a, b) => b - a));
    expect(Math.min(...weights)).toBeGreaterThanOrEqual(7); // the weakest 2..6 were cut
  });

  it('labels nodes with file and function counts and orders entry-point modules first', () => {
    const arch = buildArchitecture(graph);
    const api = arch.nodes.find((n) => n.label === 'api');
    expect(api.sublabel).toBe('2 files · 3 functions');
    expect(api.entry).toBe(true);
    expect(api.members).toEqual(['src/app/api/routes.py', 'src/app/api/auth.py']);
    expect(api.nodeRef).toBe('src/app/api/routes.py'); // file with the most functions
    expect(arch.nodes[0].label).toBe('api');
    expect(arch.nodes.find((n) => n.label === 'server').sublabel).toBe('1 file · 3 functions');
  });
});

describe('architecture intent', () => {
  it.each([
    ['Explain the overall architecture of this project', true],
    ['What is the overall structure?', true],
    ['How is the code organized?', true],
    ['Give me a high-level overview', true],
    ['What are the main components?', true],
    ['What does start do?', false],
    ['How does the election flow work?', false],
  ])('%s → %s', (q, expected) => {
    expect(isArchitectureQuestion(q)).toBe(expected);
  });
});
