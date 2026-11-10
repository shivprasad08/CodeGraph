// The API is always reached through this site's own origin: a Vercel rewrite in production
// and the Vite proxy in development forward /api/* to the backend (with /api stripped). That
// keeps the session cookie first-party.
export const API_BASE = '/api';

// While a shared view (/s/:token) is open, every request carries its share token
let shareToken = null;
export function setShareToken(token) {
  shareToken = token || null;
}

/** fetch() for the API: same-site credentials, the CSRF header, and the share token if any. */
export function apiFetch(path, init = {}) {
  const headers = new Headers(init.headers || {});
  headers.set('X-CodeGraph', '1');
  if (shareToken) headers.set('X-Share-Token', shareToken);
  return fetch(`${API_BASE}${path}`, { credentials: 'same-origin', ...init, headers });
}

async function errorFrom(response, fallback) {
  const body = await response.json().catch(() => ({}));
  const err = new Error(body.error || fallback);
  err.code = body.error_code ?? (response.status === 429 ? 'rate_limited' : undefined);
  err.status = response.status;
  return err;
}

export async function analyzeRepo(repoUrl) {
  const response = await apiFetch('/analyze', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ repo_url: repoUrl })
  });

  if (!response.ok) {
    const errorData = await response.json().catch(() => ({}));
    const err = new Error(errorData.error || `Backend returned ${response.status}`);
    err.code = errorData.error_code ?? (response.status === 429 ? 'rate_limited' : undefined);
    err.status = response.status;
    throw err;
  }

  return response.json();
}

/**
 * Follows a job's progress stream. A fetch() stream rather than EventSource, so a refused
 * request (403 private_analysis) is reported with its error code instead of "Connection lost".
 * Returns a function that stops listening.
 */
export function subscribeToJob(jobId, onEvent, onError, onDone) {
  const controller = new AbortController();
  let finished = false;
  const finish = (callback) => {
    if (finished) return;
    finished = true;
    callback();
    controller.abort();
  };

  apiFetch(`/jobs/${jobId}`, { signal: controller.signal, headers: { Accept: 'text/event-stream' } })
    .then(async (res) => {
      if (!res.ok) {
        const err = await errorFrom(res, 'Connection lost');
        finish(() => onError(err.message, err.code ?? null));
        return;
      }
      await readSSE(res, (data) => {
        if (finished) return;
        onEvent(data);
        if (data.status === 'done') finish(() => onDone(data));
        else if (data.status === 'error') finish(() => onError(data.error, data.error_code ?? null));
      });
      finish(() => onError('Connection lost'));
    })
    .catch(() => finish(() => onError('Connection lost')));

  return () => {
    finished = true;
    controller.abort();
  };
}

export async function fetchGraph(jobId) {
  const response = await apiFetch(`/graph/${jobId}`);

  if (response.status === 202) {
    throw new Error("Analysis still in progress");
  }

  if (!response.ok) {
    throw await errorFrom(response, `Failed to fetch graph (${response.status})`);
  }

  return response.json();
}

/** A finished PR impact result (throws with .code/.status: 'private_analysis', 202 while running). */
export async function fetchPR(jobId) {
  const res = await apiFetch(`/pr/${jobId}`);
  if (res.status === 202) throw Object.assign(new Error('Analysis still in progress'), { status: 202 });
  if (!res.ok) throw await errorFrom(res, `Failed to load the PR analysis (${res.status})`);
  return res.json();
}

/** The full base or head graph of a PR analysis ("show full graph"). */
export async function fetchPRGraph(jobId, side = 'head') {
  const res = await apiFetch(`/pr/${jobId}/graph/${side}`);
  if (!res.ok) throw await errorFrom(res, 'Could not load the full graph');
  return res.json();
}

// ---------------------------------------------------------------------------
// Accounts: session, history, share links
// ---------------------------------------------------------------------------

/** Where "Sign in with GitHub" goes; `next` is the page to come back to. */
export function signInUrl(next = '/analyses') {
  return `${API_BASE}/auth/github/login?next=${encodeURIComponent(next)}`;
}

/** The signed-in user ({ login, name, avatar_url }) or null. */
export async function fetchMe() {
  const res = await apiFetch('/auth/me');
  if (res.status === 401) return null;
  if (!res.ok) throw await errorFrom(res, 'Could not check sign-in');
  return (await res.json()).user;
}

export async function signOut() {
  const res = await apiFetch('/auth/logout', { method: 'POST' });
  if (!res.ok) throw await errorFrom(res, 'Could not sign out');
}

/** { signed_in, analyses: [...] } for this browser's session (signed in or not). */
export async function fetchMyAnalyses() {
  const res = await apiFetch('/me/analyses');
  if (!res.ok) throw await errorFrom(res, 'Could not load your analyses');
  return res.json();
}

export async function removeMyAnalysis(userAnalysisId) {
  const res = await apiFetch(`/me/analyses/${userAnalysisId}`, { method: 'DELETE' });
  if (!res.ok) throw await errorFrom(res, 'Could not remove the analysis');
}

/** expiresInDays: 7, 30 or null (never). Resolves with { id, url, expires_at }. */
export async function createShare(userAnalysisId, expiresInDays) {
  const res = await apiFetch('/shares', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ user_analysis_id: userAnalysisId, expires_in_days: expiresInDays }),
  });
  if (!res.ok) throw await errorFrom(res, 'Could not create the link');
  return res.json();
}

export async function listShares(userAnalysisId) {
  const query = userAnalysisId ? `?user_analysis_id=${encodeURIComponent(userAnalysisId)}` : '';
  const res = await apiFetch(`/me/shares${query}`);
  if (!res.ok) throw await errorFrom(res, 'Could not load your links');
  return (await res.json()).shares;
}

export async function revokeShare(shareId) {
  const res = await apiFetch(`/shares/${shareId}`, { method: 'DELETE' });
  if (!res.ok) throw await errorFrom(res, 'Could not turn off the link');
}

/** { share, graph } for a share link token; throws with code 'share_unavailable' when it is gone. */
export async function fetchShare(token) {
  const res = await apiFetch(`/shares/${encodeURIComponent(token)}`);
  if (!res.ok) throw await errorFrom(res, 'This link is no longer available.');
  return res.json();
}

// ---------------------------------------------------------------------------
// Cache-miss recovery
//
// The server keeps analyses in a /tmp cache that is wiped when Render restarts
// (deploy or free-tier sleep), while the browser still shows the graph. Requests
// that need the cached graph then fail with 404 "Graph data not found in cache".
// We re-analyze the repo once (shared by all concurrent requests), then retry.
// ---------------------------------------------------------------------------

/** Error codes the UI can act on. Messages are always user-facing, never raw backend text. */
export const API_ERROR = {
  CACHE_MISS: 'CACHE_MISS',         // analysis gone from the server and could not be restored
  RATE_LIMITED: 'RATE_LIMITED',
  NETWORK: 'NETWORK',
  SERVER: 'SERVER',
};

export class ApiError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
  }
}

class CacheMissError extends Error {}

const FRIENDLY = {
  [API_ERROR.CACHE_MISS]: "This analysis is no longer on the server and couldn't be reloaded.",
  [API_ERROR.RATE_LIMITED]: 'Too many requests right now. Try again in a minute.',
  [API_ERROR.NETWORK]: "Couldn't reach the server. Try again in a minute.",
  [API_ERROR.SERVER]: 'Something went wrong on the server. Try again in a minute.',
};

/** True for the server's "graph not in cache" 404. */
export function isCacheMiss(status, body) {
  const text = String(body?.detail ?? body?.error ?? '');
  return status === 404 && /not found in cache/i.test(text);
}

/** Turns any failure into an ApiError with a friendly message. */
function toApiError(err) {
  if (err instanceof ApiError) return err;
  if (err instanceof CacheMissError) return new ApiError(API_ERROR.CACHE_MISS, FRIENDLY.CACHE_MISS);
  if (err?.status === 429) return new ApiError(API_ERROR.RATE_LIMITED, FRIENDLY.RATE_LIMITED);
  if (err?.status) return new ApiError(API_ERROR.SERVER, FRIENDLY.SERVER);
  return new ApiError(API_ERROR.NETWORK, FRIENDLY.NETWORK);
}

/** Throws CacheMissError for the cache 404, an error with `.status` for other failures. */
async function ensureOk(res) {
  if (res.ok) return res;
  const body = await res.json().catch(() => ({}));
  if (isCacheMiss(res.status, body)) throw new CacheMissError();
  const err = new Error(`HTTP ${res.status}`);
  err.status = res.status;
  throw err;
}

// One re-analysis per repo at a time; concurrent requests share the promise
const reanalyses = new Map();
// After a recovery, later requests for the old commit go to the restored one
const commitRedirects = new Map();

const currentCommit = (repo, sha) => commitRedirects.get(`${repo}@${sha}`) ?? sha;

/**
 * Re-runs the analysis for "owner/repo" and resolves with { jobId, commitSha, graph }.
 * Deduplicated: while one is running, every caller gets the same promise.
 */
export function reanalyzeRepo(repoFullName) {
  if (!reanalyses.has(repoFullName)) {
    const run = (async () => {
      const { job_id: jobId } = await analyzeRepo(`https://github.com/${repoFullName}`);
      await new Promise((resolve, reject) => {
        subscribeToJob(jobId, () => {}, (e) => reject(new Error(e || 'Analysis failed')), resolve);
      });
      const graph = await fetchGraph(jobId);
      return { jobId, commitSha: graph.commit_sha, graph };
    })().finally(() => reanalyses.delete(repoFullName));
    reanalyses.set(repoFullName, run);
  }
  return reanalyses.get(repoFullName);
}

/**
 * Runs `attempt(commitSha)`. On the cache 404 it re-analyzes once and retries.
 * hooks.onRecovering() fires when the reload starts; hooks.onRecovered({ commitSha,
 * changed, jobId, graph }) when it finishes. Any failure becomes an ApiError.
 */
async function withCacheRecovery(repoFullName, commitSha, attempt, hooks = {}, signal) {
  const sha = currentCommit(repoFullName, commitSha);
  try {
    return await attempt(sha);
  } catch (err) {
    if (!(err instanceof CacheMissError) || signal?.aborted) throw err;
  }
  hooks.onRecovering?.();
  let restored;
  try {
    restored = await reanalyzeRepo(repoFullName);
  } catch {
    throw new ApiError(API_ERROR.CACHE_MISS, FRIENDLY.CACHE_MISS);
  }
  if (restored.commitSha && restored.commitSha !== sha) {
    commitRedirects.set(`${repoFullName}@${commitSha}`, restored.commitSha);
  }
  hooks.onRecovered?.({ ...restored, changed: restored.commitSha !== commitSha });
  return attempt(restored.commitSha || sha); // retried once; a second miss surfaces as CACHE_MISS
}

/** Reads a CodeGraph SSE body, calling onData for every `data:` JSON line. */
async function readSSE(res, onData) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop();
    for (const line of lines) {
      if (!line.startsWith("data: ")) continue;
      try {
        onData(JSON.parse(line.slice(6)));
      } catch {
        // ignore malformed lines
      }
    }
  }
  if (buffer.startsWith("data: ")) {
    try {
      onData(JSON.parse(buffer.slice(6)));
    } catch {
      // ignore
    }
  }
}

/**
 * Fetches a file's source. Recovers from a wiped server cache like chat does.
 * @param {object} [hooks] { onRecovering, onRecovered }
 */
export async function fetchFileSource(repoFullName, commitSha, filePath, hooks = {}) {
  const encodedPath = filePath.split("/").map(encodeURIComponent).join("/");
  try {
    return await withCacheRecovery(
      repoFullName,
      commitSha,
      async (sha) => (await ensureOk(await apiFetch(`/source/${repoFullName}/${sha}/${encodedPath}`))).json(),
      hooks,
    );
  } catch (err) {
    throw toApiError(err);
  }
}

/**
 * Streams a chat answer. Returns a function that stops the stream; stopping
 * calls onDone with the references received so far instead of onError.
 * onError(message, apiError) always gets a friendly message.
 * @param {object} [hooks] { onRecovering, onRecovered } for cache-miss recovery.
 */
export function streamChatMessage(repoFullName, commitSha, message, history, onToken, onDone, onError, hooks = {}) {
  const controller = new AbortController();
  let finished = false;
  // extra = { diagram }: the server-validated flow diagram from the final event, if any
  const done = (nodes, extra = { diagram: null }) => {
    if (finished) return;
    finished = true;
    onDone(nodes, extra);
  };
  withCacheRecovery(
    repoFullName,
    commitSha,
    async (sha) =>
      ensureOk(
        await apiFetch(`/chat/${repoFullName}/${sha}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ message, history }),
          signal: controller.signal,
        }),
      ),
    hooks,
    controller.signal,
  )
    .then((res) =>
      readSSE(res, (data) => {
        if (data.done) {
          if (data.token) onToken(data.token);
          done(data.nodes || [], { diagram: data.diagram ?? null });
        } else if (data.token) {
          onToken(data.token);
        }
      }),
    )
    .then(() => done([]))
    .catch((err) => {
      if (err?.name === "AbortError") return done([]);
      const apiError = toApiError(err);
      onError(apiError.message, apiError);
    });
  return () => controller.abort();
}

export async function fetchChatSuggestions(repoFullName, commitSha) {
  try {
    const sha = currentCommit(repoFullName, commitSha);
    const res = await apiFetch(`/chat/${repoFullName}/${sha}/suggestions`);
    if (!res.ok) return [];
    const data = await res.json();
    return data.suggestions || [];
  } catch {
    return [];
  }
}

export async function fetchAnalysis(jobId) {
  const res = await apiFetch(`/analysis/${jobId}`);
  if (!res.ok) return null;
  return res.json();
}

/**
 * Streams the AI impact analysis. onError(message, apiError) gets a friendly message.
 * @param {object} [hooks] { onRecovering, onRecovered } for cache-miss recovery.
 */
export function streamImpactAnalysis(
  repoFullName, commitSha, sourceNodeId, changeDescription, blastRadiusData,
  onToken, onDone, onError, hooks = {}
) {
  withCacheRecovery(
    repoFullName,
    commitSha,
    async (sha) =>
      ensureOk(
        await apiFetch(`/impact/${repoFullName}/${sha}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            source_node_id: sourceNodeId,
            change_description: changeDescription,
            blast_radius: blastRadiusData
          })
        }),
      ),
    hooks,
  )
    .then((res) =>
      readSSE(res, (data) => {
        if (data.done) onDone({ riskLevel: data.risk_level, nodes: data.nodes || [] });
        else if (data.token) onToken(data.token);
      }),
    )
    .catch((err) => {
      const apiError = toApiError(err);
      onError(apiError.message, apiError);
    });
}

/** Test helper: forget redirects and in-flight reloads. */
export function __resetCacheRecovery() {
  reanalyses.clear();
  commitRedirects.clear();
}
