import { cn } from '../../lib/cn';
import { focusRing } from '../../ui';
import Logo from './Logo';
import { REPO_URL } from './SiteNav';

const link = cn(
  'rounded text-cg-secondary underline-offset-4 transition-colors duration-cg-fast ease-cg hover:text-cg-text hover:underline',
  '[@media(pointer:coarse)]:inline-flex [@media(pointer:coarse)]:min-h-11 [@media(pointer:coarse)]:items-center',
  focusRing,
);

export default function SiteFooter() {
  return (
    <footer className="border-t border-cg-border">
      <div className="mx-auto flex max-w-[1120px] flex-col gap-6 px-4 py-10 text-cg-sm sm:px-6 md:flex-row md:items-center md:justify-between">
        <Logo />
        <nav aria-label="Footer" className="flex flex-wrap gap-x-6 gap-y-2">
          <a href={REPO_URL} target="_blank" rel="noopener noreferrer" className={link}>
            GitHub repo
          </a>
          <a href="#how-it-works" className={link}>
            How it works
          </a>
        </nav>
        <p className="flex flex-wrap items-center gap-x-4 gap-y-2 text-cg-secondary">
          <span>Built by Shivprasad Mahind</span>
          <a href="https://shivprasadportfolio.vercel.app" target="_blank" rel="noopener noreferrer" className={link}>
            Portfolio
          </a>
          <a href="https://github.com/shivprasad08" target="_blank" rel="noopener noreferrer" className={link}>
            GitHub
          </a>
        </p>
      </div>
    </footer>
  );
}
