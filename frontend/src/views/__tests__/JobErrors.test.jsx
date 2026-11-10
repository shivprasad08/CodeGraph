// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

// vi.mock is hoisted above imports, so shared state comes from vi.hoisted
const { jobError, never } = vi.hoisted(() => ({
  jobError: { message: '', code: null },
  never: () => new Promise(() => {}),
}));

vi.mock('../../api', () => ({
  analyzeRepo: vi.fn(never),
  subscribeToJob: vi.fn((_jobId, _onEvent, onError) => {
    queueMicrotask(() => onError(jobError.message, jobError.code));
    return () => {};
  }),
  fetchGraph: vi.fn(never),
  fetchRepo: vi.fn(never),
  fetchRepoMeta: vi.fn(never),
  fetchFileSource: vi.fn(never),
  streamChatMessage: vi.fn(never),
  fetchChatSuggestions: vi.fn(never),
  fetchAnalysis: vi.fn(never),
  streamImpactAnalysis: vi.fn(never),
  fetchMe: vi.fn(async () => null),
  signOut: vi.fn(async () => {}),
  signInUrl: (next) => `/api/auth/github/login?next=${encodeURIComponent(next)}`,
  API_ERROR: {},
}));

import ShareableGraphView from '../ShareableGraphView';

beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
});
afterEach(cleanup);

function renderJob() {
  render(
    <MemoryRouter initialEntries={['/graph/acme/docs/jobs/j1']}>
      <Routes>
        <Route path="/graph/:owner/:repo/jobs/:jobId" element={<ShareableGraphView />} />
        <Route path="/" element={<p>landing</p>} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('job errors', () => {
  it('explains a repo with no supported source files, without a pointless retry', async () => {
    jobError.message = 'No supported source files found. Most common file types: .md (12), .json (3).';
    jobError.code = 'no_source';
    renderJob();
    expect(await screen.findByText('No source files CodeGraph can read in acme/docs')).toBeTruthy();
    expect(screen.getByText(/\.md \(12\)/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Analyze another repo' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();
  });

  it('says private repositories are not supported, without a retry', async () => {
    jobError.message = "Private repositories aren't supported.";
    jobError.code = 'private_repo';
    renderJob();
    expect(await screen.findByText("Private repositories aren't supported")).toBeTruthy();
    expect(screen.getByText(/only analyzes public GitHub repositories/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Analyze another repo' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();
  });

  it("someone else's analysis: a private card with Analyze this repo and Sign in, and no graph request", async () => {
    const api = await import('../../api');
    jobError.message = 'This analysis is private.';
    jobError.code = 'private_analysis';
    renderJob();
    expect(await screen.findByText('This analysis is private')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Analyze this repo' })).toBeTruthy();
    expect(await screen.findByRole('button', { name: 'Sign in' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();
    expect(api.fetchGraph).not.toHaveBeenCalled();
  });

  it('keeps the generic error screen for other failures', async () => {
    jobError.message = 'Repo has 99 source files (JavaScript 94, TypeScript 5), limit is 60. Try a smaller repo.';
    jobError.code = 'file_limit';
    renderJob();
    expect(await screen.findByText("Couldn't analyze acme/docs")).toBeTruthy();
    expect(screen.getByText(/supported language/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy();
  });
});
