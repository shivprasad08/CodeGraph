import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  API_ERROR,
  __resetCacheRecovery,
  fetchFileSource,
  isCacheMiss,
  streamChatMessage,
  streamImpactAnalysis,
} from '../api';

const REPO = 'owner/repo';
const CACHE_404 = { detail: 'Graph data not found in cache. Please re-analyze the repo.' };

const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const sse = (...events) => new Response(events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join(''), { status: 200 });

/**
 * Tiny fake server. `routes` maps a path fragment to a list of responses
 * (one per call, last one repeats). Records every call.
 */
function fakeServer(routes) {
  const calls = [];
  const counters = {};
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url, init = {}) => {
      calls.push({ url: String(url), method: init.method || 'GET' });
      const key = Object.keys(routes).find((k) => String(url).includes(k));
      if (!key) throw new Error(`unexpected request ${url}`);
      const list = routes[key];
      const i = Math.min(counters[key] ?? 0, list.length - 1);
      counters[key] = (counters[key] ?? 0) + 1;
      const r = list[i];
      // A Response body can only be read once, so hand out a fresh copy per call
      return typeof r === 'function' ? r() : r.clone();
    }),
  );
  // Job stream finishes right away
  vi.stubGlobal(
    'EventSource',
    class {
      constructor() {
        setTimeout(() => this.onmessage?.({ data: JSON.stringify({ status: 'done', progress: 100 }) }), 0);
      }
      close() {}
    },
  );
  return {
    calls,
    count: (fragment, method) => calls.filter((c) => c.url.includes(fragment) && (!method || c.method === method)).length,
  };
}

function chat(sha = 'abc', hooks = {}) {
  return new Promise((resolve) => {
    const tokens = [];
    streamChatMessage(
      REPO,
      sha,
      'Where does it start?',
      [],
      (t) => tokens.push(t),
      (nodes) => resolve({ ok: true, tokens, nodes }),
      (message, error) => resolve({ ok: false, message, error }),
      hooks,
    );
  });
}

beforeEach(() => __resetCacheRecovery());
afterEach(() => vi.unstubAllGlobals());

describe('isCacheMiss', () => {
  it('matches only the cache 404', () => {
    expect(isCacheMiss(404, CACHE_404)).toBe(true);
    expect(isCacheMiss(404, { detail: 'Graph data not found in cache' })).toBe(true);
    expect(isCacheMiss(404, { detail: 'File not found on GitHub' })).toBe(false);
    expect(isCacheMiss(500, CACHE_404)).toBe(false);
  });
});

describe('cache-miss recovery', () => {
  it('chat: re-analyzes exactly once, then retries the original request and succeeds', async () => {
    const server = fakeServer({
      '/chat/owner/repo/abc': [json(404, CACHE_404), () => sse({ token: 'It starts in ', done: false }, { token: 'main.', done: true, nodes: ['a.py::main'] })],
      '/analyze': [json(200, { job_id: 'job-1', status: 'queued' })],
      '/graph/job-1': [json(200, { repo: REPO, commit_sha: 'abc', nodes: [], edges: [] })],
    });
    const hooks = { onRecovering: vi.fn(), onRecovered: vi.fn() };

    const result = await chat('abc', hooks);

    expect(result).toEqual({ ok: true, tokens: ['It starts in ', 'main.'], nodes: ['a.py::main'] });
    expect(server.count('/analyze', 'POST')).toBe(1);
    expect(server.count('/chat/owner/repo/abc', 'POST')).toBe(2); // original + one retry
    expect(hooks.onRecovering).toHaveBeenCalledTimes(1);
    expect(hooks.onRecovered).toHaveBeenCalledWith(expect.objectContaining({ commitSha: 'abc', changed: false, jobId: 'job-1' }));
  });

  it('dedupes: concurrent cache misses share a single re-analysis', async () => {
    const server = fakeServer({
      '/chat/owner/repo/abc': [json(404, CACHE_404), json(404, CACHE_404), () => sse({ token: 'ok', done: true, nodes: [] })],
      '/impact/owner/repo/abc': [json(404, CACHE_404), () => sse({ done: true, risk_level: 'SAFE', nodes: [] })],
      '/analyze': [json(200, { job_id: 'job-1' })],
      '/graph/job-1': [json(200, { commit_sha: 'abc' })],
    });
    const impact = new Promise((resolve) =>
      streamImpactAnalysis(REPO, 'abc', 'a.py::f', '', {}, () => {}, resolve, (m) => resolve({ error: m })),
    );
    const [a, b, c] = await Promise.all([chat(), chat(), impact]);

    expect(a.ok && b.ok).toBe(true);
    expect(c).toEqual({ riskLevel: 'SAFE', nodes: [] });
    expect(server.count('/analyze', 'POST')).toBe(1);
  });

  it('second failure: shows a friendly CACHE_MISS error, never the raw backend message', async () => {
    const server = fakeServer({
      '/chat/owner/repo/abc': [json(404, CACHE_404)], // still missing after the reload
      '/analyze': [json(200, { job_id: 'job-1' })],
      '/graph/job-1': [json(200, { commit_sha: 'abc' })],
    });
    const result = await chat();

    expect(result.ok).toBe(false);
    expect(result.error.code).toBe(API_ERROR.CACHE_MISS);
    expect(result.message).toBe("This analysis is no longer on the server and couldn't be reloaded.");
    expect(result.message).not.toMatch(/cache|re-analyze|404/i);
    expect(server.count('/analyze', 'POST')).toBe(1);
    expect(server.count('/chat/owner/repo/abc', 'POST')).toBe(2);
  });

  it('a failed re-analysis also ends in a friendly CACHE_MISS error', async () => {
    fakeServer({
      '/chat/owner/repo/abc': [json(404, CACHE_404)],
      '/analyze': [json(429, { error: 'Too many active jobs from this IP.' })],
    });
    const result = await chat();
    expect(result.error.code).toBe(API_ERROR.CACHE_MISS);
    expect(result.message).not.toMatch(/active jobs/);
  });

  it('commit changed: retries on the new commit, reports it, and later requests go straight there', async () => {
    const server = fakeServer({
      '/chat/owner/repo/old': [json(404, CACHE_404)],
      '/chat/owner/repo/new': [() => sse({ token: 'fresh', done: true, nodes: [] })],
      '/analyze': [json(200, { job_id: 'job-2' })],
      '/graph/job-2': [json(200, { commit_sha: 'new' })],
    });
    const hooks = { onRecovered: vi.fn() };

    expect((await chat('old', hooks)).tokens).toEqual(['fresh']);
    expect(hooks.onRecovered).toHaveBeenCalledWith(expect.objectContaining({ commitSha: 'new', changed: true, jobId: 'job-2' }));

    await chat('old');
    expect(server.count('/chat/owner/repo/old')).toBe(1); // second request skipped the stale commit
    expect(server.count('/analyze')).toBe(1);
  });

  it('source view: same recovery and retry', async () => {
    const server = fakeServer({
      '/source/owner/repo/abc/pkg/a.py': [json(404, CACHE_404), json(200, { path: 'pkg/a.py', content: 'x = 1' })],
      '/analyze': [json(200, { job_id: 'job-1' })],
      '/graph/job-1': [json(200, { commit_sha: 'abc' })],
    });
    const res = await fetchFileSource(REPO, 'abc', 'pkg/a.py');
    expect(res.content).toBe('x = 1');
    expect(server.count('/analyze')).toBe(1);
  });

  it('other errors do not trigger a re-analysis and stay friendly', async () => {
    const server = fakeServer({
      '/source/owner/repo/abc/pkg/a.py': [json(404, { detail: 'File not found on GitHub' })],
      '/chat/owner/repo/abc': [json(429, { error: 'Chat rate limit exceeded (20/hour)' })],
    });
    await expect(fetchFileSource(REPO, 'abc', 'pkg/a.py')).rejects.toMatchObject({ code: API_ERROR.SERVER });
    const result = await chat();
    expect(result.error.code).toBe(API_ERROR.RATE_LIMITED);
    expect(result.message).toBe('Too many requests right now. Try again in a minute.');
    expect(server.count('/analyze')).toBe(0);
  });
});
