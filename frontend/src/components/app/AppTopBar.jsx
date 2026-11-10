import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import {
  Check, Ellipsis, ExternalLink, FolderTree, History, Link2, LogOut, PanelLeft, PanelRight, Plus, RotateCw, Search, Share2,
} from 'lucide-react';
import { cn } from '../../lib/cn';
import { MOD_KEY } from '../../lib/hotkeys';
import { currentPath, signIn, signOutAndForget, useSession } from '../../lib/session';
import { Button, IconButton, Kbd, Tooltip, focusRing } from '../../ui';
import { Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger } from '../../ui/Menu';
import { LogoMark } from '../landing/Logo';
import GitHubMark from '../landing/GitHubMark';
import AccountControl from '../AccountControl';
import Avatar from '../Avatar';
import ShareDialog, { formatDate } from './ShareDialog';

// The public demo has no share links: its address is the link
const DEMO_COPY = 'Copy link';
const DEMO_COPIED = 'Copied';
const DEMO_ANNOUNCE = 'Link to the demo copied';

/** Both labels share one grid cell, so the button keeps the width of the longer one. */
function StableLabel({ label, alt, showAlt }) {
  return (
    <span className="inline-grid">
      <span className={cn('col-start-1 row-start-1', showAlt && 'invisible')}>{label}</span>
      <span className={cn('col-start-1 row-start-1', !showAlt && 'invisible')}>{alt}</span>
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

/** "Shared by @login · expires Nov 17, 2026" for a shared (read-only) view. */
export function SharedChip({ shared, className }) {
  const expiry = shared.expiresAt ? `expires ${formatDate(shared.expiresAt)}` : 'never expires';
  return (
    <span
      className={cn(
        'inline-flex h-7 min-w-0 items-center gap-1.5 rounded-cg-control border border-cg-border px-2 text-cg-xs text-cg-secondary',
        className,
      )}
    >
      <Avatar user={shared.sharedBy} size={16} />
      <span className="truncate">
        Shared by <span className="text-cg-text">@{shared.sharedBy?.login}</span> · {expiry}
      </span>
    </span>
  );
}

/**
 * 48px app bar: logo / repo / commit · search · panel toggles, share, re-run, new, account.
 * Under 768px the panel toggles open sheets and the actions move into a menu.
 * @param {object} [props.shared] Read-only shared view: { sharedBy: {login, avatar_url}, expiresAt }.
 *   Share and Re-run are hidden.
 */
export default function AppTopBar({
  owner,
  repo,
  commitSha,
  jobId,
  offline,
  shared,
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
  const navigate = useNavigate();
  const { status, user } = useSession();
  const [demoCopied, copyDemo] = useCopied();
  const [shaCopied, copySha] = useCopied();
  const [shareOpen, setShareOpen] = useState(false);
  const readOnly = Boolean(shared);
  const rerunLabel = offline ? 'Re-run is available on your own analyses' : 'Re-run analysis';
  const signedIn = status === 'signed_in';
  const demoIcon = demoCopied ? <Check {...icon} /> : <Link2 {...icon} />;

  const share = () => {
    if (offline) copyDemo(`${window.location.origin}/demo`);
    else if (signedIn) setShareOpen(true);
    else signIn(currentPath());
  };
  const shareLabel = signedIn ? 'Share' : 'Sign in to share';

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
      {shared && !isMobile && <SharedChip shared={shared} className="hidden lg:inline-flex" />}
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
                {shared && (
                  <div className="max-w-64 px-2 pb-1.5 pt-1 text-cg-xs text-cg-tertiary">
                    Shared by <span className="text-cg-secondary">@{shared.sharedBy?.login}</span> ·{' '}
                    {shared.expiresAt ? `expires ${formatDate(shared.expiresAt)}` : 'never expires'}
                  </div>
                )}
                {!readOnly && (
                  <MenuItem icon={offline ? demoIcon : <Share2 {...icon} />} onSelect={share} disabled={!offline && status === 'loading'}>
                    {offline ? <StableLabel label={DEMO_COPY} alt={DEMO_COPIED} showAlt={demoCopied} /> : status === 'loading' ? 'Share' : shareLabel}
                  </MenuItem>
                )}
                {!readOnly && (
                  <MenuItem icon={<RotateCw {...icon} />} onSelect={onRerun} disabled={offline || rerunning}>
                    {rerunLabel}
                  </MenuItem>
                )}
                <MenuItem icon={<Plus {...icon} />} onSelect={onNew}>
                  New analysis
                </MenuItem>
                <MenuSeparator />
                {signedIn ? (
                  <>
                    <div className="flex items-center gap-2 px-2 py-1 text-cg-xs text-cg-tertiary">
                      <Avatar user={user} size={16} /> @{user.login}
                    </div>
                    <MenuItem icon={<History {...icon} />} onSelect={() => navigate('/analyses')}>
                      My analyses
                    </MenuItem>
                    <MenuItem
                      icon={<LogOut {...icon} />}
                      onSelect={async () => {
                        await signOutAndForget().catch(() => {});
                        navigate('/');
                      }}
                    >
                      Sign out
                    </MenuItem>
                  </>
                ) : (
                  <MenuItem icon={<GitHubMark size={16} />} onSelect={() => signIn(currentPath())} disabled={status === 'loading'}>
                    Sign in with GitHub
                  </MenuItem>
                )}
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
            {shared && <SharedChip shared={shared} className="mr-1 lg:hidden" />}
            {!readOnly &&
              (offline ? (
                <Tooltip content="Copy a link to this demo">
                  <span className="inline-flex">
                    <Button size="sm" variant="secondary" onClick={share} leadingIcon={demoIcon}>
                      <StableLabel label={DEMO_COPY} alt={DEMO_COPIED} showAlt={demoCopied} />
                    </Button>
                  </span>
                </Tooltip>
              ) : (
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={share}
                  disabled={status === 'loading'}
                  leadingIcon={signedIn ? <Share2 {...icon} /> : <GitHubMark size={16} />}
                >
                  {status === 'loading' ? 'Share' : shareLabel}
                </Button>
              ))}
            {!readOnly && (
              <Tooltip content={rerunLabel}>
                {/* span keeps the tooltip working while the button is disabled */}
                <span className="inline-flex">
                  <IconButton label="Re-run analysis" tooltip={false} onClick={onRerun} disabled={offline || rerunning}>
                    <RotateCw {...icon} className={rerunning ? 'motion-safe:animate-spin' : undefined} />
                  </IconButton>
                </span>
              </Tooltip>
            )}
            <IconButton label="New analysis" onClick={onNew}>
              <Plus {...icon} />
            </IconButton>
            <span aria-hidden="true" className="mx-1 h-5 w-px bg-cg-border" />
            <AccountControl compact />
          </>
        )}
      </div>
      {/* Outside the menu, so the announcement survives the menu closing */}
      <span className="sr-only" aria-live="polite">
        {demoCopied ? DEMO_ANNOUNCE : ''}
      </span>
      {!offline && !readOnly && signedIn && (
        <ShareDialog open={shareOpen} onOpenChange={setShareOpen} repo={`${owner}/${repo}`} commitSha={commitSha} jobId={jobId} />
      )}
    </TopBarFrame>
  );
}
