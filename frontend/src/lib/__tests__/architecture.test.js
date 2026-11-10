import { describe, expect, it } from 'vitest';
import { HIDDEN_MODULE_ID, buildArchitecture, isArchitectureQuestion } from '../architecture';

const file = (id) => ({ id, type: 'file' });
const fn = (file, name, extra = {}) => ({ id: `${file}::${name}`, label: name, type: 'function', file, ...extra });
const call = (s, t) => ({ source: s, target: t, type: 'calls' });

const nodes = [
  file('app/api/routes.py'),
  file('app/api/auth.py'),
  file('app/db/models.py'),
  file('app/server.py'),
  file('scripts/seed.py'),
  file('tests/test_api.py'),
  fn('app/api/routes.py', 'index'),
  fn('app/api/routes.py', 'login'),
  fn('app/api/auth.py', 'check'),
  fn('app/db/models.py', 'save'),
  fn('app/db/models.py', 'load'),
  fn('app/server.py', 'run', { is_entry_point: true }),
  fn('scripts/seed.py', 'seed', { is_entry_point: true }),
  fn('tests/test_api.py', 'test_index'),
];

const architecture = {
  method: 'directories',
  modules: [
    { id: 'mod:api', label: 'api', files: ['app/api/auth.py', 'app/api/routes.py'], function_count: 3, class_count: 0, has_entry_points: false },
    { id: 'mod:db', label: 'db', files: ['app/db/models.py'], function_count: 2, class_count: 0, has_entry_points: false },
    { id: 'mod:server', label: 'server', files: ['app/server.py'], function_count: 1, class_count: 0, has_entry_points: true },
  ],
  edges: [
    { source: 'mod:api', target: 'mod:db', calls: 3, imports: 1, weight: 4 },
    { source: 'mod:server', target: 'mod:api', calls: 0, imports: 2, weight: 2 },
  ],
  hidden: ['scripts/seed.py', 'tests/test_api.py'],
};

const edges = [
  call('scripts/seed.py::seed', 'app/db/models.py::save'),
  call('scripts/seed.py::seed', 'app/db/models.py::load'),
  call('tests/test_api.py::test_index', 'app/api/routes.py::index'), // weight 1 → dropped
  call('app/api/routes.py::index', 'app/db/models.py::load'), // between visible modules: already in architecture
];
const graph = { nodes, edges, architecture };

describe('buildArchitecture (maps graph.architecture)', () => {
  const spec = buildArchitecture(graph);

  it('labels modules with file and function counts and puts entry-point modules first', () => {
    expect(spec.missing).toBe(false);
    expect(spec.method).toBe('directories');
    expect(spec.nodes.map((n) => n.id)).toEqual(['mod:server', 'mod:api', 'mod:db']); // entry first, then in-degree (api 2 < db 4)
    const api = spec.nodes.find((n) => n.id === 'mod:api');
    expect(api.sublabel).toBe('2 files · 3 functions');
    expect(spec.nodes.find((n) => n.id === 'mod:server').sublabel).toBe('1 file · 1 function');
    expect(api.members).toEqual(['app/api/auth.py', 'app/api/routes.py']);
    expect(api.nodeRef).toBe('app/api/routes.py'); // most symbols
    expect(api.kind).toBe('module');
  });

  it('labels edges by calls, or imports when there are no calls', () => {
    expect(spec.edges).toEqual([
      { id: 'mod:api→mod:db', source: 'mod:api', target: 'mod:db', weight: 4, label: '3 calls' },
      { id: 'mod:server→mod:api', source: 'mod:server', target: 'mod:api', weight: 2, label: '2 imports' },
    ]);
  });

  it('reports hidden files and can add them as one module with its own edges', () => {
    expect(spec.hiddenCount).toBe(2);
    expect(spec.nodes.some((n) => n.id === HIDDEN_MODULE_ID)).toBe(false);
    const withHidden = buildArchitecture(graph, { includeHidden: true });
    const hidden = withHidden.nodes.find((n) => n.id === HIDDEN_MODULE_ID);
    expect(hidden.label).toBe('scripts and tests');
    expect(hidden.sublabel).toBe('2 files · 2 functions');
    expect(hidden.entry).toBe(true);
    expect(withHidden.edges).toContainEqual({
      id: `${HIDDEN_MODULE_ID}→mod:db`, source: HIDDEN_MODULE_ID, target: 'mod:db', weight: 2, label: '2 calls',
    });
    expect(withHidden.edges.some((e) => e.target === 'mod:api' && e.source === HIDDEN_MODULE_ID)).toBe(false);
  });

  it('passes groups through and tags each module with its group', () => {
    const withGroups = {
      ...graph,
      architecture: {
        ...architecture,
        groups: [{ id: 'grp:app', label: 'app', files: ['app/api/auth.py', 'app/api/routes.py', 'app/db/models.py'] }],
        modules: architecture.modules.map((m) => (m.id === 'mod:server' ? m : { ...m, parent: 'grp:app' })),
      },
    };
    const out = buildArchitecture(withGroups);
    expect(out.groups).toEqual([{ id: 'grp:app', label: 'app' }]);
    expect(Object.fromEntries(out.nodes.map((n) => [n.id, n.group]))).toEqual({
      'mod:server': null, 'mod:api': 'grp:app', 'mod:db': 'grp:app',
    });
    expect(buildArchitecture(graph).groups).toEqual([]);
  });

  it('flags graphs analysed before the architecture view existed', () => {
    const old = buildArchitecture({ nodes, edges });
    expect(old.missing).toBe(true);
    expect(old.nodes).toEqual([]);
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
