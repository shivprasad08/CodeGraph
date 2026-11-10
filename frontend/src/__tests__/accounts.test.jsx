// @vitest-environment jsdom
// Sign-in chrome, /analyses, the share dialog and /s/:token (API mocked).
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

const { api } = vi.hoisted(() => ({
  api: {
    fetchMe: vi.fn(async () => null),
    signOut: vi.fn(async () => {}),
    signInUrl: (next) => `/api/auth/github/login?next=${encodeURIComponent(next)}`,
    fetchMyAnalyses: vi.fn(),
    removeMyAnalysis: vi.fn(async () => {}),
    createShare: vi.fn(),
    listShares: vi.fn(async () => []),
    revokeShare: vi.fn(async () => {}),
    fetchShare: vi.fn(),
    setShareToken: vi.fn(),
  },
}));
vi.mock('../api', () => api);
// The graph app view is tested elsewhere; here only what SharedView hands it matters
vi.mock('../views/ShareableGraphView', () => ({
  default: (props) => (
    <div data-testid="app-view">
      {props.staticData.repo} shared by {props.shared.sharedBy.login} until {String(props.shared.expiresAt)}
    </div>
  ),
}));

import { __setSession } from '../lib/session';
import AccountControl from '../components/AccountControl';
import AnalysesView from '../views/AnalysesView';
import ShareDialog from '../components/app/ShareDialog';
import SharedView from '../views/SharedView';

const ALICE = { login: 'alice', name: 'Alice', avatar_url: 'https://avatars.test/a' };
const ANALYSIS = {
  id: 'ua-1', job_id: 'job-1', repo: 'acme/widgets', commit_sha: 'abc12345', status: 'done',
  languages: [{ lang: 'python', label: 'Python', files: 4 }], health_score: 81, health_grade: 'B',
  created_at: '2026-11-10T10:00:00Z', shares: 1,
};

beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  Object.defineProperty(window, 'location', {
    configurable: true,
    value: { ...window.location, assign: vi.fn(), origin: 'https://app.test', pathname: '/analyses', search: '' },
  });
});
beforeEach(() => {
  vi.clearAllMocks();
  api.listShares.mockResolvedValue([]);
});
afterEach(cleanup);

const renderAt = (ui, path = '/') => render(<MemoryRouter initialEntries={[path]}>{ui}</MemoryRouter>);

describe('top bar account control', () => {
  it('signed out: offers "Sign in with GitHub", which starts the OAuth flow back to this page', async () => {
    act(() => __setSession({ status: 'signed_out', user: null }));
    renderAt(<AccountControl />);
    const button = screen.getByRole('button', { name: /sign in/i });
    expect(button.textContent).toContain('Sign in with GitHub');
    await userEvent.click(button);
    expect(window.location.assign).toHaveBeenCalledWith('/api/auth/github/login?next=%2Fanalyses');
  });

  it('signed in: avatar + login open a menu with My analyses and Sign out', async () => {
    act(() => __setSession({ status: 'signed_in', user: ALICE }));
    renderAt(<AccountControl />);
    const trigger = await screen.findByRole('button', { name: 'Account: alice' });
    expect(screen.queryByRole('button', { name: /sign in/i })).toBeNull();
    await userEvent.click(trigger);
    expect(await screen.findByRole('menuitem', { name: 'My analyses' })).toBeTruthy();
    await userEvent.click(screen.getByRole('menuitem', { name: 'Sign out' }));
    await waitFor(() => expect(api.signOut).toHaveBeenCalled());
  });

  it('renders nothing while the session is loading', () => {
    act(() => __setSession({ status: 'loading', user: null }));
    const { container } = renderAt(<AccountControl />);
    expect(container.textContent).toBe('');
  });
});

describe('/analyses', () => {
  it('lists the analyses newest first and removes one after confirming', async () => {
    act(() => __setSession({ status: 'signed_in', user: ALICE }));
    api.fetchMyAnalyses.mockResolvedValue({
      signed_in: true,
      analyses: [ANALYSIS, { ...ANALYSIS, id: 'ua-2', job_id: 'job-2', repo: 'pallets/flask', shares: 0, health_score: null }],
    });
    renderAt(<AnalysesView />, '/analyses');
    const list = await screen.findByRole('list');
    const rows = within(list).getAllByRole('listitem');
    expect(rows.map((r) => r.querySelector('.font-cg-mono').textContent)).toEqual(['acme/widgets', 'pallets/flask']);
    expect(rows[0].textContent).toContain('abc12345');
    expect(rows[0].textContent).toContain('Python');
    expect(rows[0].textContent).toMatch(/Health 81 \(B\)/);
    expect(rows[0].textContent).toContain('1 active link');
    expect(within(rows[0]).getByRole('link', { name: 'acme/widgets' }).getAttribute('href')).toBe('/graph/acme/widgets/jobs/job-1');

    await userEvent.click(within(rows[0]).getByRole('button', { name: 'Actions for acme/widgets' }));
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Remove from list' }));
    const dialog = await screen.findByRole('dialog', { name: 'Remove acme/widgets from your list?' });
    expect(api.removeMyAnalysis).not.toHaveBeenCalled(); // nothing happens before confirming
    await userEvent.click(within(dialog).getByRole('button', { name: 'Remove' }));
    await waitFor(() => expect(api.removeMyAnalysis).toHaveBeenCalledWith('ua-1'));
    await waitFor(() => expect(screen.queryByRole('link', { name: 'acme/widgets' })).toBeNull());
    expect(screen.getByRole('link', { name: 'pallets/flask' })).toBeTruthy();
  });

  it('shows an empty state with "Analyze a repo"', async () => {
    act(() => __setSession({ status: 'signed_in', user: ALICE }));
    api.fetchMyAnalyses.mockResolvedValue({ signed_in: true, analyses: [] });
    renderAt(<AnalysesView />, '/analyses');
    expect(await screen.findByText('No analyses yet')).toBeTruthy();
    expect(screen.getAllByRole('button', { name: 'Analyze a repo' }).length).toBeGreaterThan(0);
  });

  it('signed out: asks to sign in to keep the analyses, and still lists this browser\'s', async () => {
    act(() => __setSession({ status: 'signed_out', user: null }));
    api.fetchMyAnalyses.mockResolvedValue({ signed_in: false, analyses: [{ ...ANALYSIS, shares: 0 }] });
    renderAt(<AnalysesView />, '/analyses');
    expect(await screen.findByRole('heading', { name: 'Sign in to keep your analyses' })).toBeTruthy();
    expect(await screen.findByRole('link', { name: 'acme/widgets' })).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Actions for acme/widgets' }));
    expect(await screen.findByRole('menuitem', { name: 'Sign in to share' })).toBeTruthy();
  });
});

describe('share dialog', () => {
  it('creates a link with the chosen expiry, shows it to copy, and revokes after confirming', async () => {
    api.listShares
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ id: 's-1', created_at: '2026-11-10T10:00:00Z', expires_at: '2026-12-10T10:00:00Z', revoked_at: null, view_count: 2, active: true }])
      .mockResolvedValue([{ id: 's-1', created_at: '2026-11-10T10:00:00Z', expires_at: '2026-12-10T10:00:00Z', revoked_at: '2026-11-11T10:00:00Z', view_count: 2, active: false }]);
    api.createShare.mockResolvedValue({ id: 's-1', url: '/s/tok123', expires_at: '2026-12-10T10:00:00Z' });
    renderAt(<ShareDialog open onOpenChange={() => {}} repo="acme/widgets" commitSha="abc12345" userAnalysisId="ua-1" />);

    expect(await screen.findByText('No links yet.')).toBeTruthy();
    await userEvent.click(screen.getByRole('radio', { name: '30 days' }));
    await userEvent.click(screen.getByRole('button', { name: 'Create link' }));
    expect(api.createShare).toHaveBeenCalledWith('ua-1', 30);
    expect((await screen.findByLabelText('Share link')).value).toBe('https://app.test/s/tok123');
    expect(await screen.findByText(/2 views/)).toBeTruthy();

    await userEvent.click(screen.getByRole('button', { name: 'Revoke' }));
    const confirm = await screen.findByRole('dialog', { name: 'Revoke this link?' });
    await userEvent.click(within(confirm).getByRole('button', { name: 'Revoke link' }));
    await waitFor(() => expect(api.revokeShare).toHaveBeenCalledWith('s-1'));
    expect(await screen.findByText(/turned off/)).toBeTruthy();
  });

  it('"Never" creates a link without expiry', async () => {
    api.createShare.mockResolvedValue({ id: 's-2', url: '/s/tok', expires_at: null });
    renderAt(<ShareDialog open onOpenChange={() => {}} repo="acme/widgets" userAnalysisId="ua-1" />);
    await screen.findByText('No links yet.');
    await userEvent.click(screen.getByRole('radio', { name: 'Never' }));
    await userEvent.click(screen.getByRole('button', { name: 'Create link' }));
    expect(api.createShare).toHaveBeenCalledWith('ua-1', null);
  });
});

describe('/s/:token', () => {
  const renderShare = () =>
    render(
      <MemoryRouter initialEntries={['/s/tok123']}>
        <Routes>
          <Route path="/s/:token" element={<SharedView />} />
        </Routes>
      </MemoryRouter>,
    );

  it('opens the shared analysis read-only, with the token on every request', async () => {
    api.fetchShare.mockResolvedValue({
      share: { repo: 'acme/widgets', commit_sha: 'abc12345', expires_at: '2026-12-10T10:00:00Z', shared_by: { login: 'alice', avatar_url: null } },
      graph: { repo: 'acme/widgets', commit_sha: 'abc12345', nodes: [], edges: [] },
    });
    renderShare();
    expect((await screen.findByTestId('app-view')).textContent).toBe('acme/widgets shared by alice until 2026-12-10T10:00:00Z');
    expect(api.setShareToken).toHaveBeenCalledWith('tok123');
    cleanup();
    expect(api.setShareToken).toHaveBeenLastCalledWith(null); // cleared when leaving the page
  });

  it('says the link is no longer available when it is revoked, expired or unknown', async () => {
    api.fetchShare.mockRejectedValue(Object.assign(new Error('gone'), { code: 'share_unavailable', status: 404 }));
    renderShare();
    expect(await screen.findByRole('heading', { name: 'This link is no longer available' })).toBeTruthy();
    expect(screen.queryByTestId('app-view')).toBeNull();
  });
});
