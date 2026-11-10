// Page pattern: marketing landing — nav, hero with the primary action, live product demo,
// how it works, feature rows, stack, honest limits, footer.
import { useEffect, useRef, useState } from 'react';
import { X } from 'lucide-react';
import { IconButton } from '../ui';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { normalizeRepoInput, parsePrInput } from '../lib/repoInput';
import { analyzeRepo } from '../api';
import { signIn, useSession } from '../lib/session';
import Hero from '../components/Hero';
import SiteNav from '../components/landing/SiteNav';
import LiveDemo from '../components/landing/LiveDemo';
import HowItWorks from '../components/landing/HowItWorks';
import FeatureRows from '../components/landing/FeatureRows';
import SiteFooter from '../components/landing/SiteFooter';
import Reveal from '../components/landing/Reveal';

const STACK = ['tree-sitter', 'networkx', 'FastAPI', 'SSE streaming', 'commit-SHA cache', 'Groq / Mistral'];

// Where the GitHub sign-in callback sends people back when it did not complete
const SIGNIN_NOTICES = {
  failed: "Sign-in didn't complete. Try again, or keep using CodeGraph without an account.",
  cancelled: 'Sign-in was cancelled. You can still analyze repositories without an account.',
  unavailable: "Sign-in isn't available right now. You can still analyze repositories without an account.",
};

const LIMITS = [
  'Full support: Python. Basic support: JavaScript, TypeScript, Java, Go, Rust, C/C++, C#, Ruby, PHP and more.',
  'Up to 60 source files',
  'AI summaries cover the 60 most-connected functions',
  'Runs on a free tier, so the first request may take a minute',
];

export default function LandingPageView() {
  const navigate = useNavigate();
  const inputRef = useRef(null);
  const { status } = useSession();
  // A shared /graph/owner/repo link lands here with the repo prefilled (?repo=owner/repo)
  const [searchParams] = useSearchParams();
  const prefillParam = searchParams.get('repo') ?? '';
  const prefilledRepo = parsePrInput(prefillParam)?.path || normalizeRepoInput(prefillParam) || '';
  const [signinNotice, setSigninNotice] = useState(() => SIGNIN_NOTICES[searchParams.get('signin')] ?? '');
  useEffect(() => {
    if (prefilledRepo) inputRef.current?.focus();
  }, [prefilledRepo]);

  useEffect(() => {
    document.title = 'CodeGraph — Map any codebase';
  }, []);

  // Start the job, then open its page (graph, or PR impact). Errors propagate to Hero.
  const handleAnalyze = async (path) => {
    const pr = parsePrInput(path);
    const result = await analyzeRepo(`https://github.com/${path}`);
    if (pr) {
      navigate(`/pr/${pr.owner}/${pr.repo}/${pr.number}/jobs/${result.job_id}`);
      return;
    }
    const [owner, repo] = path.split('/');
    navigate(`/graph/${owner}/${repo}/jobs/${result.job_id}`);
  };

  const focusRepoInput = () => {
    const field = inputRef.current;
    if (!field) return;
    const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    field.scrollIntoView({ behavior: reduce ? 'auto' : 'smooth', block: 'center' });
    field.focus({ preventScroll: true });
  };

  return (
    <div className="min-h-screen bg-cg-canvas font-cg-sans text-cg-text">
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-50 focus:rounded-cg-control focus:bg-cg-primary focus:px-3 focus:py-2 focus:text-cg-sm focus:text-cg-on-primary focus:outline focus:outline-2 focus:outline-offset-2 focus:outline-cg-focus"
      >
        Skip to content
      </a>
      <SiteNav onAnalyzeClick={focusRepoInput} />
      <main id="main" className="flex flex-col gap-16 pb-16 md:gap-28 md:pb-28">
        {signinNotice && (
          <div className="mx-auto -mb-10 mt-4 w-full max-w-[560px] px-4 md:-mb-20">
            <p role="status" className="flex items-start gap-2 rounded-cg-control border border-cg-border bg-cg-raised py-2 pl-3 pr-1 text-cg-sm text-cg-text">
              <span className="flex-1">{signinNotice}</span>
              <IconButton label="Dismiss" size="sm" tooltip={false} onClick={() => setSigninNotice('')}>
                <X size={16} strokeWidth={1.5} aria-hidden="true" />
              </IconButton>
            </p>
          </div>
        )}
        <Hero
          onAnalyze={handleAnalyze}
          inputRef={inputRef}
          initialRepo={prefilledRepo}
          onSignIn={status === 'signed_out' ? () => signIn() : undefined}
        />
        <LiveDemo />
        <HowItWorks />
        <FeatureRows />

        <Reveal as="section" aria-labelledby="stack-title" className="mx-auto w-full max-w-[1120px] px-4 sm:px-6">
          <div className="border-y border-cg-border py-6">
            <h2 id="stack-title" className="sr-only">
              Under the hood
            </h2>
            <p className="text-center text-cg-sm text-cg-secondary">
              <span className="text-cg-tertiary">Built with </span>
              {STACK.map((item, i) => (
                <span key={item}>
                  {i > 0 && <span aria-hidden="true" className="text-cg-tertiary"> · </span>}
                  <span className="whitespace-nowrap">{item}</span>
                </span>
              ))}
            </p>
          </div>
        </Reveal>

        <Reveal as="section" aria-labelledby="limits-title" className="mx-auto w-full max-w-[1120px] px-4 sm:px-6">
          <div className="max-w-[560px] rounded-cg-panel border border-cg-border bg-cg-raised p-6 shadow-cg-edge">
            <h2 id="limits-title" className="text-cg-lg font-semibold text-cg-text">
              Limits
            </h2>
            <ul className="mt-3 flex list-disc flex-col gap-1.5 pl-5 text-cg-base text-cg-secondary marker:text-cg-tertiary">
              {LIMITS.map((limit) => (
                <li key={limit}>{limit}</li>
              ))}
            </ul>
          </div>
        </Reveal>
      </main>
      <SiteFooter />
    </div>
  );
}
