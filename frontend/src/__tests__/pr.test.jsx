// @vitest-environment jsdom
// PR impact view: tabs, risk factors, Changes → Blast radius selection, empty and private cases,
// the architecture spec, /analyses PR rows and PR detection on the landing page.
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

const { api, canvasProps } = vi.hoisted(() => ({
  canvasProps: { current: null },
  api: {
    fetchMe: vi.fn(async () => null),
    signOut: vi.fn(async () => {}),
    signInUrl: (next) => `/api/auth/github/login?next=${encodeURIComponent(next)}`,
    subscribeToJob: vi.fn(),
    fetchPR: vi.fn(),
    fetchPRGraph: vi.fn(),
    fetchMyAnalyses: vi.fn(),
    removeMyAnalysis: vi.fn(),
    createShare: vi.fn(),
    listShares: vi.fn(async () => []),
    revokeShare: vi.fn(),
  },
}));
vi.mock('../api', () => api);
vi.mock('../components/GraphCanvas', () => ({
  default: (props) => {
    canvasProps.current = props;
    return <div data-testid="canvas">{props.graph.nodes.length} nodes</div>;
  },
}));
vi.mock('../components/diagram/DiagramFrame', () => ({
  default: ({ spec }) => <div data-testid="diagram">{spec.nodes.length} modules</div>,
}));

import { __setSession } from '../lib/session';
import PRView from '../views/PRView';
import AnalysesView from '../views/AnalysesView';
import Hero from '../components/Hero';
import { limitDepth } from '../components/pr/BlastRadiusTab';
import { prArchitectureSpec } from '../components/pr/PRArchitectureTab';
import { parsePrInput } from '../lib/repoInput';

const RESULT = {
  pr: {
    owner: 'acme', repo: 'app', number: 7, title: 'Tidy store', author: 'dev', author_avatar: null, state: 'merged',
    html_url: 'https://github.com/acme/app/pull/7', base_sha: 'a'.repeat(40), head_sha: 'b'.repeat(40), is_fork: false,
  },
  partial: false,
  changes: [
    { id: 'app/a.py::Store.get', qualified_name: 'Store.get', file: 'app/a.py', module: 'core', kind: 'modified', lines_added: 2, lines_removed: 1, callers: 3, signature_changed: true, params_before: 1, params_after: 2, breaking: true },
    { id: 'app/b.py::fresh', qualified_name: 'fresh', file: 'app/b.py', module: 'api', kind: 'added', lines_added: 9, lines_removed: 0, callers: 0, signature_changed: false, breaking: false },
  ],
  impacted: [
    { id: 'app/c.py::use', label: 'use', depth: 1, exact: true, module: 'core' },
    { id: 'app/d.py::far', label: 'far', depth: 3, exact: false, module: 'core' },
  ],
  modules: [{ label: 'core', changed: 1, impacted: 2 }, { label: 'api', changed: 1, impacted: 0 }],
  signals: [
    { kind: 'signature_change', node: 'app/a.py::Store.get', message: 'Store.get now takes 2 parameters (was 1); 1 caller weren\'t updated' },
    { kind: 'new_module_dependency', source: 'api', target: 'core', message: 'New dependency: api → core' },
  ],
  risk: {
    score: 41, level: 'medium',
    factors: [
      { key: 'changed', label: 'Changed code', points: 2, max: 15, reason: '2 functions or classes changed' },
      { key: 'blast', label: 'Blast radius', points: 2, max: 25, reason: '2 functions depend on the changes' },
      { key: 'hubs', label: 'Entry points and hubs', points: 5, max: 15, reason: 'Touches Store.get' },
      { key: 'breaking', label: 'Breaking-change signals', points: 18, max: 40, reason: '2 signals' },
      { key: 'spread', label: 'Cross-module spread', points: 3, max: 10, reason: 'Affects 2 modules' },
      { key: 'tests', label: 'Tests', points: 10, max: 10, reason: 'Source code changed but no test files did' },
    ],
  },
  summary: { text: 'Changes `Store.get` and adds fresh.', source: 'ai' },
  files: [
    { filename: 'app/a.py', status: 'modified', additions: 2, deletions: 1, mapped: true, nodes: 1, note: null, test: false },
    { filename: 'README.md', status: 'modified', additions: 1, deletions: 1, mapped: false, nodes: 0, note: 'Not source code CodeGraph analyses', test: false },
  ],
  subgraph: {
    repo: 'acme/app', commit_sha: 'bbbbbbbb',
    nodes: [
      { id: 'app/a.py', type: 'file', file: 'app/a.py' },
      { id: 'app/a.py::Store.get', type: 'function', file: 'app/a.py', qualified_name: 'Store.get', pr_change: 'modified' },
      { id: 'app/b.py::fresh', type: 'function', file: 'app/b.py', qualified_name: 'fresh', pr_change: 'added' },
      { id: 'app/c.py::use', type: 'function', file: 'app/c.py', label: 'use', pr_depth: 1, pr_exact: true },
      { id: 'app/d.py::far', type: 'function', file: 'app/d.py', label: 'far', pr_depth: 3, pr_exact: false },
    ],
    edges: [
      { source: 'app/c.py::use', target: 'app/a.py::Store.get', type: 'calls' },
      { source: 'app/d.py::far', target: 'app/c.py::use', type: 'calls' },
    ],
  },
  architecture: {
    head: {
      modules: [
        { id: 'mod:core', label: 'core', files: ['app/a.py', 'app/c.py'], function_count: 2, class_count: 0 },
        { id: 'mod:api', label: 'api', files: ['app/b.py'], function_count: 1, class_count: 0 },
        { id: 'mod:cli', label: 'cli', files: ['app/e.py'], function_count: 1, class_count: 0 },
      ],
      edges: [],
    },
    base: { modules: [], edges: [] },
  },
  stats: { changed: 2, impacted: 2, files: 2 },
};

beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
});
beforeEach(() => {
  vi.clearAllMocks();
  canvasProps.current = null;
  act(() => __setSession({ status: 'signed_out', user: null }));
});
afterEach(cleanup);

function renderPR({ error = null } = {}) {
  api.subscribeToJob.mockImplementation((_id, onEvent, onError, onDone) => {
    queueMicrotask(() => (error ? onError(error.message, error.code) : onDone({ status: 'done' })));
    return () => {};
  });
  api.fetchPR.mockResolvedValue(RESULT);
  return render(
    <MemoryRouter initialEntries={['/pr/acme/app/7/jobs/j1']}>
      <Routes>
        <Route path="/pr/:owner/:repo/:number/jobs/:jobId" element={<PRView />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('PR view', () => {
  it('shows the header, every risk factor with its points, the summary and the four tabs', async () => {
    renderPR();
    expect(await screen.findByRole('heading', { level: 1, name: /Tidy store/ })).toBeTruthy();
    expect(screen.getByText('Merged')).toBeTruthy();
    expect(screen.getByText(/aaaaaaaa → bbbbbbbb/)).toBeTruthy();
    expect(screen.getByRole('link', { name: /View on GitHub/ }).getAttribute('href')).toBe('https://github.com/acme/app/pull/7');
    expect(screen.getByText('Medium risk')).toBeTruthy();
    const factors = within(screen.getByRole('list', { name: 'Risk factors' })).getAllByRole('listitem');
    expect(factors).toHaveLength(6);
    expect(factors[3].textContent).toContain('Breaking-change signals');
    expect(factors[3].textContent).toContain('+18');
    expect(screen.getByText('Store.get', { selector: 'code' })).toBeTruthy(); // backticks → code
    expect(screen.getAllByRole('tab').map((t) => t.textContent)).toEqual(['Changes', 'Blast radius', 'Architecture', 'Files']);
    expect(screen.getByText('Signature 1 → 2 params')).toBeTruthy();
    expect(screen.getByText('Breaking')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Sign in to share' })).toBeTruthy();
  });

  it('selecting a change opens Blast radius with that node selected and the overlay set', async () => {
    renderPR();
    await userEvent.click(await screen.findByRole('button', { name: /Store\.get/ }));
    expect(screen.getByRole('tab', { name: 'Blast radius' }).getAttribute('aria-selected')).toBe('true');
    await waitFor(() => expect(canvasProps.current?.selectedNodeId).toBe('app/a.py::Store.get'));
    const { prOverlay, zoomToNodes } = canvasProps.current;
    expect(prOverlay.changes.get('app/a.py::Store.get')).toBe('modified');
    expect(prOverlay.changes.get('app/b.py::fresh')).toBe('added');
    expect(prOverlay.depths.get('app/c.py::use')).toBe(1);
    expect(zoomToNodes).toEqual(expect.arrayContaining(['app/a.py::Store.get', 'app/c.py::use']));
    // Depth 1 hides the depth-3 caller
    await userEvent.click(screen.getByRole('radio', { name: '1' }));
    await waitFor(() => expect(canvasProps.current.graph.nodes.some((n) => n.id === 'app/d.py::far')).toBe(false));
  });

  it('lists the PR files with their mapping notes', async () => {
    renderPR();
    await userEvent.click(await screen.findByRole('tab', { name: 'Files' }));
    expect(screen.getByText('Not source code CodeGraph analyses')).toBeTruthy();
    expect(screen.getByText(/Mapped · 1 function or class changed/)).toBeTruthy();
  });

  it("someone else's PR analysis shows the private card", async () => {
    renderPR({ error: { message: 'This analysis is private.', code: 'private_analysis' } });
    expect(await screen.findByText('This analysis is private')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Analyze this PR' })).toBeTruthy();
    expect(api.fetchPR).not.toHaveBeenCalled();
  });

  it('a PR without source changes says so and points to Files', async () => {
    api.fetchPR.mockResolvedValue({ ...RESULT, changes: [], impacted: [] });
    api.subscribeToJob.mockImplementation((_id, _e, _err, onDone) => {
      queueMicrotask(() => onDone({ status: 'done' }));
      return () => {};
    });
    render(
      <MemoryRouter initialEntries={['/pr/acme/app/7/jobs/j1']}>
        <Routes>
          <Route path="/pr/:owner/:repo/:number/jobs/:jobId" element={<PRView />} />
        </Routes>
      </MemoryRouter>,
    );
    expect(await screen.findByText("This PR doesn't change any analysed source files")).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'See files' }));
    expect(screen.getByRole('tab', { name: 'Files' }).getAttribute('aria-selected')).toBe('true');
  });
});

describe('PR helpers', () => {
  it('architecture spec: affected modules outlined, others faded, new dependencies dashed', () => {
    const spec = prArchitectureSpec(RESULT);
    const byLabel = Object.fromEntries(spec.nodes.map((n) => [n.label, n]));
    expect(byLabel.core.highlight && byLabel.core.sublabel).toBe('1 changed · 2 impacted');
    expect(byLabel.cli.muted).toBe(true);
    const added = spec.edges.find((e) => e.source === 'mod:api' && e.target === 'mod:core');
    expect(added).toMatchObject({ dashed: true, label: 'new' });
  });

  it('limitDepth keeps changed nodes, impacted nodes up to the depth, and their files', () => {
    const g = limitDepth(RESULT.subgraph, 1);
    expect(g.nodes.map((n) => n.id).sort()).toEqual(['app/a.py', 'app/a.py::Store.get', 'app/b.py::fresh', 'app/c.py::use']);
    expect(g.edges).toHaveLength(1);
  });
});

describe('/analyses PR row', () => {
  it('shows the PR chip, title and risk, and links to the PR view', async () => {
    act(() => __setSession({ status: 'signed_in', user: { login: 'dev' } }));
    api.fetchMyAnalyses.mockResolvedValue({
      signed_in: true,
      analyses: [{ id: 'ua-1', job_id: 'j1', kind: 'pr', repo: 'acme/app', pr_number: 7, pr_title: 'Tidy store', risk_level: 'high', risk_score: 72, status: 'done', created_at: '2026-11-10T10:00:00Z', shares: 0, languages: [] }],
    });
    render(
      <MemoryRouter>
        <AnalysesView />
      </MemoryRouter>,
    );
    const link = await screen.findByRole('link', { name: 'acme/app' });
    expect(link.getAttribute('href')).toBe('/pr/acme/app/7/jobs/j1');
    const row = link.closest('li');
    expect(row.textContent).toContain('PR #7');
    expect(row.textContent).toContain('Tidy store');
    expect(row.textContent).toContain('High risk');
    expect(row.textContent).toContain('(72)');
  });
});

describe('landing PR detection', () => {
  it('recognises PR links and the owner/repo#n shorthand', () => {
    expect(parsePrInput('https://github.com/pallets/flask/pull/6096/files')).toMatchObject({ path: 'pallets/flask/pull/6096', number: 6096 });
    expect(parsePrInput('pallets/flask#6096')).toMatchObject({ label: 'pallets/flask#6096' });
    expect(parsePrInput('pallets/flask')).toBeNull();
  });

  it('the button reads "Analyze PR" for a PR link and passes the PR path on', async () => {
    const onAnalyze = vi.fn(async () => {});
    render(<Hero onAnalyze={onAnalyze} />);
    const field = screen.getByLabelText('GitHub repository');
    await userEvent.type(field, 'https://github.com/pallets/flask/pull/6096');
    expect(screen.getByRole('button', { name: 'Analyze PR' })).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Analyze PR' }));
    expect(onAnalyze).toHaveBeenCalledWith('pallets/flask/pull/6096');
    await userEvent.clear(field);
    await userEvent.type(field, 'psf/requests');
    expect(screen.getByRole('button', { name: 'Analyze repo' })).toBeTruthy();
  });

  it('"Try a PR" fills in the example flask PR', async () => {
    render(<Hero onAnalyze={vi.fn()} />);
    await userEvent.click(screen.getByRole('button', { name: 'pallets/flask#6096' }));
    expect(screen.getByLabelText('GitHub repository').value).toBe('pallets/flask/pull/6096');
    expect(screen.getByRole('button', { name: 'Analyze PR' })).toBeTruthy();
  });
});
