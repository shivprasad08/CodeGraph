// Parsing for the "GitHub repository" field on the landing page.

const URL_PREFIX = /^\s*(?:https?:\/\/)?(?:www\.)?github\.com\//i;
const OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const REPO = /^[A-Za-z0-9._-]{1,100}$/;

/** Removes a leading "https://github.com/" (or "github.com/") so the field only holds owner/repo. */
export function stripGitHubPrefix(value) {
  return value.replace(URL_PREFIX, '');
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
