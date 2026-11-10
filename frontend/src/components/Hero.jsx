import { useEffect, useState } from 'react';
import { ArrowRight } from 'lucide-react';
import { cn } from '../lib/cn';
import { normalizeRepoInput, stripGitHubPrefix } from '../lib/repoInput';
import { Button, Input, focusRing } from '../ui';

export const EXAMPLE_REPOS = ['psf/requests', 'pallets/flask', 'encode/starlette', 'fastapi/fastapi', 'expressjs/express'];
export const COLD_START_DELAY_MS = 4000;

const INVALID_REPO = 'Enter a repository as owner/repo, for example psf/requests.';

/**
 * Landing hero with the repository form.
 * @param {(repoPath: string) => Promise<void>} props.onAnalyze Starts the analysis for "owner/repo".
 *   Should navigate on success and throw an Error with a readable message on failure.
 * @param {import('react').Ref<HTMLInputElement>} [props.inputRef] Lets the nav focus the field.
 * @param {() => void} [props.onSignIn] When given (signed out), a line under the field offers sign-in.
 */
export default function Hero({ onAnalyze, inputRef, initialRepo = '', onSignIn }) {
  const [value, setValue] = useState(initialRepo);
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [slow, setSlow] = useState(false);

  // Free-tier cold start: explain the wait if the request is still running after 4s
  useEffect(() => {
    if (!submitting) {
      setSlow(false);
      return undefined;
    }
    const timer = setTimeout(() => setSlow(true), COLD_START_DELAY_MS);
    return () => clearTimeout(timer);
  }, [submitting]);

  async function handleSubmit(event) {
    event.preventDefault();
    if (submitting) return;
    const repoPath = normalizeRepoInput(value);
    if (!repoPath) {
      setError(INVALID_REPO);
      return;
    }
    setError('');
    setValue(repoPath);
    setSubmitting(true);
    try {
      await onAnalyze(repoPath);
    } catch (err) {
      if (err?.code === 'rate_limited' || err?.code === 'private_repo') {
        setError(err.message); // already says what to do next (when to retry / why)
        return;
      }
      setError(
        err?.message
          ? `Couldn't start the analysis: ${err.message.replace(/\.\s*$/, '')}. Try again in a minute.`
          : "Couldn't reach the server. Try again in a minute.",
      );
    } finally {
      setSubmitting(false);
    }
  }

  function fillExample(repo) {
    setValue(repo);
    setError('');
    const field = inputRef && 'current' in inputRef ? inputRef.current : null;
    field?.focus();
  }

  // No bottom padding: the gap between sections comes from <main> (64px / 112px)
  return (
    <section aria-labelledby="hero-title" className="mx-auto w-full max-w-[1120px] px-4 pt-12 sm:px-6 md:pt-24">
      <div className="mx-auto flex max-w-[640px] flex-col items-center text-center md:mx-0 md:items-start md:text-left">
        <h1
          id="hero-title"
          className="text-balance text-[36px] font-semibold leading-[40px] tracking-[-0.02em] text-cg-text sm:text-cg-display"
        >
          See how a codebase fits together.
        </h1>
        <p className="mt-5 max-w-[560px] text-cg-lg text-cg-secondary">
          Paste a GitHub repo. CodeGraph parses it with tree-sitter, maps every call and import, and lets you
          ask questions about the code.
        </p>

        <form onSubmit={handleSubmit} noValidate className="mt-10 w-full max-w-[560px]" aria-busy={submitting || undefined}>
          <div className="flex flex-col gap-3 min-[480px]:flex-row min-[480px]:items-start">
            <Input
              ref={inputRef}
              id="repo-input"
              label="GitHub repository"
              size="lg"
              prefix="github.com/"
              placeholder="owner/repo"
              autoComplete="off"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              enterKeyHint="go"
              value={value}
              onChange={(e) => {
                setValue(stripGitHubPrefix(e.target.value));
                if (error) setError('');
              }}
              error={error || undefined}
              className="flex-1 text-left"
            />
            <Button
              type="submit"
              variant="primary"
              size="lg"
              loading={submitting}
              trailingIcon={<ArrowRight size={16} strokeWidth={1.5} aria-hidden="true" />}
              className="w-full min-[480px]:mt-[26px] min-[480px]:w-auto"
            >
              Analyze repo
            </Button>
          </div>
          <p aria-live="polite" className="mt-3 min-h-5 text-left text-cg-sm text-cg-tertiary">
            {slow ? 'Waking up the server — the first request can take up to a minute.' : ''}
          </p>
        </form>
        {onSignIn && (
          <p className="text-cg-sm text-cg-secondary">
            <button
              type="button"
              onClick={onSignIn}
              className={cn(
                'rounded text-cg-text underline decoration-cg-border-strong underline-offset-4',
                'transition-colors duration-cg-fast ease-cg hover:decoration-cg-text',
                '[@media(pointer:coarse)]:inline-flex [@media(pointer:coarse)]:min-h-11 [@media(pointer:coarse)]:items-center',
                focusRing,
              )}
            >
              Sign in with GitHub
            </button>{' '}
            to save and share your analyses.
          </p>
        )}

        <p className="mt-4 text-cg-sm text-cg-secondary">
          <span className="text-cg-tertiary">Try </span>
          {EXAMPLE_REPOS.map((repo, i) => (
            <span key={repo}>
              {i > 0 && <span aria-hidden="true" className="text-cg-tertiary"> · </span>}
              <button
                type="button"
                onClick={() => fillExample(repo)}
                className={cn(
                  'rounded font-cg-mono text-cg-secondary underline decoration-cg-border-strong underline-offset-4',
                  'transition-colors duration-cg-fast ease-cg hover:text-cg-text hover:decoration-cg-text',
                  '[@media(pointer:coarse)]:inline-flex [@media(pointer:coarse)]:min-h-11 [@media(pointer:coarse)]:items-center',
                  focusRing,
                )}
              >
                {repo}
              </button>
            </span>
          ))}
        </p>
        <p className="mt-2 text-cg-sm text-cg-tertiary">Free · open source · repos up to 60 source files</p>
      </div>
    </section>
  );
}
