import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { cn } from '../../lib/cn';
import { Button, focusRing } from '../../ui';
import Logo from './Logo';
import GitHubMark from './GitHubMark';
import AccountControl from '../AccountControl';

export const REPO_URL = 'https://github.com/shivprasad08/CodeGraph';

const textLink = cn(
  'inline-flex h-9 items-center rounded-cg-control px-2 text-cg-sm text-cg-secondary',
  'transition-colors duration-cg-fast ease-cg hover:text-cg-text [@media(pointer:coarse)]:min-h-11',
  focusRing,
);

/**
 * Sticky 64px nav. The hairline border appears only after the page scrolls.
 * @param {() => void} [props.onAnalyzeClick] Scrolls to and focuses the repository field
 *   (landing). Elsewhere "Analyze a repo" goes to the landing page.
 * @param {boolean} [props.showHowItWorks=true] The in-page link exists only on the landing page.
 */
export default function SiteNav({ onAnalyzeClick, showHowItWorks = true }) {
  const navigate = useNavigate();
  const [scrolled, setScrolled] = useState(false);

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 4);
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  return (
    <header
      className={cn(
        'sticky top-0 z-40 h-16 border-b bg-cg-canvas transition-colors duration-cg-fast ease-cg',
        scrolled ? 'border-cg-border' : 'border-transparent',
      )}
    >
      <nav aria-label="Main" className="mx-auto flex h-full max-w-[1120px] items-center justify-between gap-4 px-4 sm:px-6">
        <Link to="/" aria-label="CodeGraph home" className={cn('-mx-1 inline-flex items-center rounded-cg-control px-1 py-1 [@media(pointer:coarse)]:min-h-11', focusRing)}>
          <Logo />
        </Link>
        <div className="flex items-center gap-1 sm:gap-2">
          {showHowItWorks && (
            <a href="#how-it-works" className={cn(textLink, 'hidden sm:inline-flex')}>
              How it works
            </a>
          )}
          <a
            href={REPO_URL}
            target="_blank"
            rel="noopener noreferrer"
            aria-label="CodeGraph on GitHub"
            className={cn(textLink, 'hidden w-9 justify-center px-0 sm:inline-flex [@media(pointer:coarse)]:w-11')}
          >
            <GitHubMark size={18} />
          </a>
          <Button size="sm" variant="secondary" onClick={onAnalyzeClick ?? (() => navigate('/'))}>
            Analyze a repo
          </Button>
          <AccountControl />
        </div>
      </nav>
    </header>
  );
}
