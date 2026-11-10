// Parsing for the "GitHub repository" field on the landing page.

const URL_PREFIX = /^\s*(?:https?:\/\/)?(?:www\.)?github\.com\//i;
const OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const REPO = /^[A-Za-z0-9._-]{1,100}$/;

/** Removes a leading "https://github.com/" (or "github.com/") so the field only holds owner/repo. */
export function stripGitHubPrefix(value) {
  return value.replace(URL_PREFIX, '');
}

const PR_PATH = /^([^/\s]+)\/([^/\s#]+)(?:\/pull\/(\d+)(?:\/[^?#]*)?|#(\d+))\/?$/;

/**
 * A pull request in user input, or null: full PR URLs (also …/files, …/commits, a trailing
 * slash, query or fragment), "owner/repo/pull/123" and the shorthand "owner/repo#123".
 * @returns {{owner: string, repo: string, number: number, path: string, label: string} | null}
 */
export function parsePrInput(value) {
  if (typeof value !== 'string') return null;
  let text = stripGitHubPrefix(value.trim());
  if (!/#\d+\/?$/.test(text)) text = text.split(/[?#]/)[0]; // keep "#123" shorthand, drop URL fragments
  const m = PR_PATH.exec(text);
  if (!m) return null;
  const owner = m[1];
  const repo = m[2].replace(/\.git$/i, '');
  if (!OWNER.test(owner) || !REPO.test(repo)) return null;
  const number = Number(m[3] ?? m[4]);
  if (!Number.isSafeInteger(number) || number < 1) return null;
  return { owner, repo, number, path: `${owner}/${repo}/pull/${number}`, label: `${owner}/${repo}#${number}` };
}

/**
 * Normalizes user input to "owner/repo", or returns null if it is not a repository.
 * Accepts "owner/repo", "github.com/owner/repo", full URLs (incl. /tree/… paths,
 * query strings and fragments) and a trailing ".git" or "/".
 */
export function normalizeRepoInput(value) {
  if (typeof value !== 'string') return null;
  const path = stripGitHubPrefix(value.trim()).split(/[?#]/)[0];
  const [owner, rawRepo] = path.split('/');
  if (!owner || !rawRepo) return null;
  const repo = rawRepo.replace(/\.git$/i, '');
  if (!OWNER.test(owner) || !REPO.test(repo) || repo === '.' || repo === '..') return null;
  return `${owner}/${repo}`;
}
