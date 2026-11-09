import { describe, expect, it } from 'vitest';
import { normalizeRepoInput, stripGitHubPrefix } from '../repoInput';

describe('normalizeRepoInput', () => {
  it.each([
    ['owner/repo', 'owner/repo'],
    ['  psf/requests  ', 'psf/requests'],
    ['https://github.com/pallets/flask', 'pallets/flask'],
    ['http://www.github.com/pallets/flask/', 'pallets/flask'],
    ['github.com/encode/starlette', 'encode/starlette'],
    ['https://github.com/fastapi/fastapi.git', 'fastapi/fastapi'],
    ['fastapi/fastapi.git', 'fastapi/fastapi'],
    ['https://github.com/psf/requests/tree/main/src', 'psf/requests'],
    ['https://github.com/psf/requests?tab=readme#top', 'psf/requests'],
    ['shivprasad08/mini_redis', 'shivprasad08/mini_redis'],
  ])('%s → %s', (input, expected) => {
    expect(normalizeRepoInput(input)).toBe(expected);
  });

  it.each(['', 'psf', 'https://github.com/psf', 'https://gitlab.com/a/b', 'owner/..', '-bad/repo', 'a b/c'])(
    'rejects %j',
    (input) => {
      expect(normalizeRepoInput(input)).toBeNull();
    },
  );
});

describe('stripGitHubPrefix', () => {
  it('removes the URL prefix but keeps the rest for normalizing on submit', () => {
    expect(stripGitHubPrefix('https://github.com/psf/requests.git')).toBe('psf/requests.git');
    expect(stripGitHubPrefix('owner/repo')).toBe('owner/repo');
  });
});
