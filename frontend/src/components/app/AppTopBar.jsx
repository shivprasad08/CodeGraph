import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Check, Ellipsis, ExternalLink, FolderTree, Link2, PanelLeft, PanelRight, Plus, RotateCw, Search } from 'lucide-react';
import { cn } from '../../lib/cn';
import { MOD_KEY } from '../../lib/hotkeys';
import { Button, IconButton, Kbd, Tooltip, focusRing } from '../../ui';
import { Menu, MenuContent, MenuItem, MenuTrigger } from '../../ui/Menu';
import { LogoMark } from '../landing/Logo';

// Until real share links exist, the link opens CodeGraph with this repo ready to analyze
const SHARE_LABEL = 'Copy analyze link';
const SHARE_TOOLTIP = 'Opens CodeGraph with this repo ready to analyze';
const SHARE_COPIED = 'Copied';
const SHARE_ANNOUNCE = 'Link copied — opens with this repo ready to analyze';

/** Both labels share one grid cell, so the button keeps the width of the longer one. */
function ShareLabel({ copied }) {
  return (
    <span className="inline-grid">
      <span className={cn('col-start-1 row-start-1', copied && 'invisible')}>{SHARE_LABEL}</span>
      <span className={cn('col-start-1 row-start-1', !copied && 'invisible')}>{SHARE_COPIED}</span>
    </span>
  );
}

const icon = { size: 16, strokeWidth: 1.5, 'aria-hidden': true };

function useCopied() {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return undefined;
    const id = setTimeout(() => setCopied(false), 2000);
    return () => clearTimeout(id);
  }, [copied]);
  const copy = async (text) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };
  return [copied, copy];
}

/** Logo / repo breadcrumb only (used while loading or on error). */
export function TopBarFrame({ repoLabel, children }) {
  return (
    <header className="flex h-12 shrink-0 items-center gap-2 border-b border-cg-border bg-cg-raised px-2 font-cg-sans sm:px-3">
      <Link to="/" aria-label="CodeGraph home" className={cn('inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-cg-control text-cg-text hover:bg-cg-hover [@media(pointer:coarse)]:h-11 [@media(pointer:coarse)]:w-11', focusRing)}>
        <LogoMark size={18} />
      </Link>
      {repoLabel && (
        <>
          <span aria-hidden="true" className="text-cg-tertiary">/</span>
          {repoLabel}
        </>
      )}
      {children}
    </header>
  );
}

/**
 * 48px app bar: logo / repo / commit · search · panel toggles, share, re-run, new.
 * Under 768px the panel toggles open sheets and the actions move into a menu.
 */
export default function AppTopBar({
  owner,
  repo,
  commitSha,
  offline,
  isMobile,
  leftOpen,
  rightOpen,
  onToggleLeft,
  onToggleRight,
  onOpenSearch,
  onRerun,
  rerunning,
  onNew,
}) {
  const [shareCopied, copyShare] = useCopied();
  const [shaCopied, copySha] = useCopied();
  const shareUrl = offline ? `${window.location.origin}/demo` : `${window.location.origin}/graph/${owner}/${repo}`;
  const shareIcon = shareCopied ? <Check {...icon} /> : <Link2 {...icon} />;
  const rerunLabel = offline ? 'Re-run is available on your own analyses' : 'Re-run analysis';

  const repoLabel = (
    <div className="flex min-w-0 items-center gap-2">
      <a
        href={`https://github.com/${owner}/${repo}`}
        target="_blank"
        rel="noopener noreferrer"
        className={cn('inline-flex min-w-0 items-center gap-1.5 rounded font-cg-mono text-cg-sm text-cg-text hover:underline underline-offset-4 [@media(pointer:coarse)]:min-h-11', focusRing)}
      >
        <span className="truncate">
          {owner}/{repo}
        </span>
        <ExternalLink size={14} strokeWidth={1.5} aria-hidden="true" className="shrink-0 text-cg-tertiary" />
        <span className="sr-only">(opens GitHub)</span>
      </a>
      {commitSha && !isMobile && (
        <Tooltip content={shaCopied ? 'Copied' : 'Copy commit'}>
          <button
            type="button"
            onClick={() => copySha(commitSha)}
            aria-label={`Copy commit ${commitSha}`}
            className={cn('h-6 shrink-0 rounded border border-cg-border px-1.5 font-cg-mono text-cg-xs text-cg-tertiary hover:bg-cg-hover hover:text-cg-secondary', focusRing)}
          >
            {commitSha.slice(0, 8)}
          </button>
        </Tooltip>
      )}
    </div>
  );

  return (
    <TopBarFrame repoLabel={repoLabel}>
      <div className="flex flex-1 justify-center px-2">
        {!isMobile && (
          <button
            type="button"
            onClick={onOpenSearch}
            aria-keyshortcuts="Meta+K Control+K /"
            className={cn(
              'flex h-8 w-full max-w-[360px] items-center gap-2 rounded-cg-control border border-cg-border-strong bg-cg-canvas px-2.5 text-left text-cg-sm text-cg-tertiary',
              'transition-colors duration-cg-fast ease-cg hover:text-cg-secondary',
              focusRing,
            )}
          >
            <Search {...icon} />
            <span className="flex-1 truncate">Search files and functions…</span>
            <Kbd>{MOD_KEY === '⌘' ? '⌘K' : 'Ctrl K'}</Kbd>
          </button>
        )}
      </div>

      <div className="flex shrink-0 items-center gap-0.5">
        {isMobile ? (
          <>
            <IconButton label="Files" onClick={onToggleLeft}>
              <FolderTree {...icon} />
            </IconButton>
            <IconButton label="Search" shortcut="/" onClick={onOpenSearch}>
              <Search {...icon} />
            </IconButton>
            <IconButton label="Inspector" onClick={onToggleRight}>
              <PanelRight {...icon} />
            </IconButton>
            <Menu>
              <MenuTrigger asChild>
                <IconButton label="More actions" tooltip={false}>
                  <Ellipsis {...icon} />
                </IconButton>
              </MenuTrigger>
              <MenuContent align="end">
                <MenuItem icon={shareIcon} onSelect={() => copyShare(shareUrl)}>
                  <ShareLabel copied={shareCopied} />
                </MenuItem>
                <MenuItem icon={<RotateCw {...icon} />} onSelect={onRerun} disabled={offline || rerunning}>
                  {rerunLabel}
                </MenuItem>
                <MenuItem icon={<Plus {...icon} />} onSelect={onNew}>
                  New analysis
                </MenuItem>
              </MenuContent>
            </Menu>
          </>
        ) : (
          <>
            <IconButton label={leftOpen ? 'Hide file tree' : 'Show file tree'} shortcut="[" onClick={onToggleLeft} aria-pressed={leftOpen}>
              <PanelLeft {...icon} />
            </IconButton>
            <IconButton label={rightOpen ? 'Hide inspector' : 'Show inspector'} shortcut="]" onClick={onToggleRight} aria-pressed={rightOpen}>
              <PanelRight {...icon} />
            </IconButton>
            <span aria-hidden="true" className="mx-1 h-5 w-px bg-cg-border" />
            <Tooltip content={SHARE_TOOLTIP}>
              <span className="inline-flex">
                <Button size="sm" variant="secondary" onClick={() => copyShare(shareUrl)} leadingIcon={shareIcon}>
                  <ShareLabel copied={shareCopied} />
                </Button>
              </span>
            </Tooltip>
            <Tooltip content={rerunLabel}>
              {/* span keeps the tooltip working while the button is disabled */}
              <span className="inline-flex">
                <IconButton label="Re-run analysis" tooltip={false} onClick={onRerun} disabled={offline || rerunning}>
                  <RotateCw {...icon} className={rerunning ? 'motion-safe:animate-spin' : undefined} />
                </IconButton>
              </span>
            </Tooltip>
            <IconButton label="New analysis" onClick={onNew}>
              <Plus {...icon} />
            </IconButton>
          </>
        )}
      </div>
      {/* Outside the menu, so the announcement survives the menu closing */}
      <span className="sr-only" aria-live="polite">
        {shareCopied ? SHARE_ANNOUNCE : ''}
      </span>
    </TopBarFrame>
  );
}
