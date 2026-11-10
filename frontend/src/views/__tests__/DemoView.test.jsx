// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

// Every backend call goes through ../api; fail loudly if any is used
vi.mock('../../api', () => {
  const fail = (name) => vi.fn(() => { throw new Error(`backend call: ${name}`); });
  return {
    analyzeRepo: fail('analyzeRepo'),
    subscribeToJob: fail('subscribeToJob'),
    fetchGraph: fail('fetchGraph'),
    fetchRepo: fail('fetchRepo'),
    fetchRepoMeta: fail('fetchRepoMeta'),
    fetchFileSource: fail('fetchFileSource'),
    streamChatMessage: fail('streamChatMessage'),
    fetchChatSuggestions: fail('fetchChatSuggestions'),
    fetchAnalysis: fail('fetchAnalysis'),
    streamImpactAnalysis: fail('streamImpactAnalysis'),
    // The top bar asks who is signed in (not an analysis request): signed out
    fetchMe: vi.fn(async () => null),
    signOut: vi.fn(async () => {}),
    signInUrl: (next) => `/api/auth/github/login?next=${encodeURIComponent(next)}`,
  };
});
// The canvas renderer needs a real browser; everything else renders for real
vi.mock('../../components/GraphCanvas', async () => {
  const { forwardRef } = await import('react');
  return {
    default: forwardRef(function GraphCanvasMock() {
      return <div data-testid="graph-canvas" />;
    }),
    NODE_COLORS: { entry: '#0f0', file: '#00f', class: '#fa0', function: '#a0f' },
  };
});

// react-resizable-panels needs real layout (jsdom has none); this stand-in keeps the
// same imperative contract so the shortcut wiring can be tested. The real library is
// checked in the browser.
vi.mock('react-resizable-panels', async () => {
  const React = await import('react');
  const Panel = React.forwardRef(function Panel({ children, onCollapse, onExpand }, ref) {
    const [collapsed, setCollapsed] = React.useState(false);
    React.useImperativeHandle(ref, () => ({
      isCollapsed: () => collapsed,
      collapse: () => {
        setCollapsed(true);
        onCollapse?.();
      },
      expand: () => {
        setCollapsed(false);
        onExpand?.();
      },
    }));
    return collapsed ? null : <div>{children}</div>;
  });
  return {
    Panel,
    PanelGroup: ({ children }) => <div>{children}</div>,
    PanelResizeHandle: () => <div />,
  };
});

// React Flow needs real layout; the lazy diagram renderer is swapped for a list
vi.mock('../../components/diagram/FlowDiagram', () => ({
  default: ({ spec, onNodeClick, ariaLabel }) => (
    <ul aria-label={ariaLabel} data-testid="flow-diagram">
      {spec.nodes.map((n) => (
        <li key={n.id}>
          <button type="button" onClick={() => onNodeClick?.(n)}>
            {n.label}
          </button>
        </li>
      ))}
    </ul>
  ),
}));

import * as api from '../../api';
import DemoView from '../DemoView';
import { DEMO_DATA_URL } from '../../lib/demo';

// jsdom tests run with cwd = frontend/ (import.meta.url is not a file: URL here)
const demoFile = JSON.parse(readFileSync(resolve(process.cwd(), 'public/demo/mini_redis.json'), 'utf8'));

// Module grouping as the backend stores it (graph.architecture). Supplied here so the test
// does not depend on whether the committed demo JSON was generated before or after it existed.
const demoFiles = demoFile.nodes.filter((n) => n.type === 'file').map((n) => n.id);
const inDir = (dir) => demoFiles.filter((f) => f.startsWith(dir));
const architecture = {
  method: 'directories',
  modules: [
    { id: 'mod:election', label: 'election', files: inDir('src/miniredis/election/'), function_count: 40, class_count: 4, has_entry_points: false },
    { id: 'mod:replication', label: 'replication', files: inDir('src/miniredis/replication/'), function_count: 60, class_count: 6, has_entry_points: false },
  ],
  edges: [{ source: 'mod:election', target: 'mod:replication', calls: 5, imports: 1, weight: 6 }],
  hidden: inDir('scripts/'),
};
let demo = { ...demoFile, architecture };

beforeAll(() => {
  // jsdom gaps used by cmdk / react-resizable-panels
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  Element.prototype.scrollIntoView ??= function scrollIntoView() {};
});

beforeEach(() => {
  demo = { ...demoFile, architecture };
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => demo })));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.localStorage.clear();
});

async function renderDemo() {
  render(
    <MemoryRouter initialEntries={['/demo']}>
      <Routes>
        <Route path="/demo" element={<DemoView />} />
        <Route path="/" element={<p>landing</p>} />
      </Routes>
    </MemoryRouter>,
  );
  await screen.findByTestId('graph-canvas');
}

const press = (key, opts = {}) => fireEvent.keyDown(document.body, { key, ...opts });
const activeTab = () => screen.getAllByRole('tab').find((t) => t.getAttribute('aria-selected') === 'true')?.textContent;

describe('/demo app view', () => {
  it('renders the saved graph without calling the backend', async () => {
    await renderDemo();
    expect(screen.getAllByText(`${demo.repo.split('/')[0]}/${demo.repo.split('/')[1]}`).length).toBeGreaterThan(0);
    expect(screen.getByRole('tree', { name: 'Files' })).toBeTruthy();

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledWith(DEMO_DATA_URL);
    for (const [name, fn] of Object.entries(api)) {
      if (name === 'fetchMe') continue; // the top bar's sign-in check; no analysis data
      if (typeof fn === 'function' && 'mock' in fn) expect(fn, name).not.toHaveBeenCalled();
    }
  });

  it('shows the Details empty state, then the node after selecting from ⌘K', async () => {
    await renderDemo();
    expect(screen.getByText('Select a node')).toBeTruthy();

    await act(async () => press('k', { metaKey: true }));
    const dialog = await screen.findByRole('dialog');
    const input = within(dialog).getByPlaceholderText('Search files and functions…');
    fireEvent.change(input, { target: { value: 'repair_now' } });
    const option = await within(dialog).findByRole('option', { name: /repair_now/ });
    fireEvent.click(option);

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(screen.getByRole('heading', { level: 2, name: 'repair_now' })).toBeTruthy();
    expect(screen.getByText(/Callers/)).toBeTruthy();
    expect(screen.getByText(/src\/miniredis\/node\.py:\d+/)).toBeTruthy();
    expect(screen.queryByText('Select a node')).toBeNull();
  });

  it('opens the palette with "/" and filters by path', async () => {
    await renderDemo();
    await act(async () => press('/'));
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByPlaceholderText('Search files and functions…'), { target: { value: 'dispatcher.py' } });
    await waitFor(() => {
      const options = within(dialog).getAllByRole('option');
      expect(options.length).toBeGreaterThan(0);
      expect(options.every((o) => o.textContent.includes('dispatcher.py'))).toBe(true);
    });
    await act(async () => press('Escape'));
  });

  it('switches inspector tabs with 1–4', async () => {
    await renderDemo();
    expect(activeTab()).toBe('Details');
    await act(async () => press('3'));
    expect(activeTab()).toBe('Health');
    // The demo file's own health score (it changes whenever the demo is regenerated)
    expect(screen.getAllByText(String(demoFile.analysis.score)).length).toBeGreaterThan(0);
    await act(async () => press('2'));
    expect(activeTab()).toBe('Chat');
    expect(screen.getByText('Chat is available on your own analyses')).toBeTruthy();
    await act(async () => press('4'));
    expect(activeTab()).toBe('Impact');
    await act(async () => press('1'));
    expect(activeTab()).toBe('Details');
  });

  it('collapses and restores the side panels with [ and ]', async () => {
    await renderDemo();
    expect(screen.getByRole('button', { name: 'Hide file tree' }).getAttribute('aria-pressed')).toBe('true');

    await act(async () => press('['));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Show file tree' }).getAttribute('aria-pressed')).toBe('false'));
    await act(async () => press('['));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Hide file tree' })).toBeTruthy());

    await act(async () => press(']'));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Show inspector' })).toBeTruthy());
  });

  it('switches to the Architecture view and back to the graph on a module click', async () => {
    await renderDemo();
    const group = screen.getByRole('radiogroup', { name: 'Canvas view' });
    expect(within(group).getByRole('radio', { name: 'Graph' }).getAttribute('aria-checked')).toBe('true');

    fireEvent.click(within(group).getByRole('radio', { name: 'Architecture' }));
    const diagram = await screen.findByTestId('flow-diagram');
    expect(within(diagram).getByRole('button', { name: 'election' })).toBeTruthy();
    expect(within(diagram).queryByRole('button', { name: 'scripts' })).toBeNull(); // hidden by default
    expect(screen.getByText(/Grouped by directory/)).toBeTruthy();

    fireEvent.click(within(diagram).getByRole('button', { name: 'election' }));
    await waitFor(() => expect(screen.queryByTestId('flow-diagram')).toBeNull());
    expect(within(group).getByRole('radio', { name: 'Graph' }).getAttribute('aria-checked')).toBe('true');
    expect(activeTab()).toBe('Details');
    // Details shows the module's main file
    expect(screen.getByRole('heading', { level: 2, name: (name) => name.startsWith('src/miniredis/election/') })).toBeTruthy();
  });

  it('asks for a re-run when the graph predates the architecture view', async () => {
    demo = { ...demoFile };
    delete demo.architecture;
    await renderDemo();
    const group = screen.getByRole('radiogroup', { name: 'Canvas view' });
    fireEvent.click(within(group).getByRole('radio', { name: 'Architecture' }));
    const heading = await screen.findByRole('heading', { name: 'Re-run analysis to see the architecture view' });
    expect(screen.queryByTestId('flow-diagram')).toBeNull();
    // The static demo has no backend, so the message offers no re-run button
    expect(within(heading.parentElement).queryByRole('button')).toBeNull();
  });

  it('ignores single-key shortcuts while typing', async () => {
    await renderDemo();
    await act(async () => press('3'));
    expect(activeTab()).toBe('Health');
    const textarea = document.createElement('textarea');
    document.body.appendChild(textarea);
    fireEvent.keyDown(textarea, { key: '1' });
    expect(activeTab()).toBe('Health');
    textarea.remove();
  });
});
