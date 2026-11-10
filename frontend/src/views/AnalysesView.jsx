// Page pattern: list — the analyses of this browser's session, newest first.
// Signed in: the user's history (kept), with Share. Signed out: this browser's analyses
// (kept 7 days) and a prompt to sign in to keep and share them.
import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Ellipsis, ExternalLink, Share2, Trash2 } from 'lucide-react';
import { fetchMyAnalyses, removeMyAnalysis } from '../api';
import { cn } from '../lib/cn';
import { languageName } from '../lib/languages';
import { signIn, useSession } from '../lib/session';
import { Button, Dialog, DialogClose, DialogContent, IconButton, Spinner, buttonClasses, focusRing } from '../ui';
import { Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger } from '../ui/Menu';
import SiteNav from '../components/landing/SiteNav';
import ShareDialog, { formatDate } from '../components/app/ShareDialog';
import { RISK_LEVEL } from '../lib/risk';

const icon = { size: 16, strokeWidth: 1.5, 'aria-hidden': true };

/** The graph's languages ([{ lang, label, files }]), most files first, top three names. */
function topLanguages(languages) {
  if (!Array.isArray(languages)) return [];
  return [...languages]
    .sort((a, b) => (b.files ?? 0) - (a.files ?? 0))
    .slice(0, 3)
    .map((l) => l.label || languageName(l.lang));
}

function openPath(a) {
  const [owner, repo] = a.repo.split('/');
  if (!a.job_id) return null;
  return a.kind === 'pr' ? `/pr/${owner}/${repo}/${a.pr_number}/jobs/${a.job_id}` : `/graph/${owner}/${repo}/jobs/${a.job_id}`;
}

function StatusText({ a }) {
  if (a.status === 'done' && a.kind === 'pr') {
    const level = RISK_LEVEL[a.risk_level];
    return level ? (
      <span>
        <span className={level.className}>{level.word}</span> <span className="text-cg-tertiary">({a.risk_score})</span>
      </span>
    ) : null;
  }
  if (a.status === 'done') {
    // Analyses saved before scores were stored have none to show
    return a.health_score == null ? null : (
      <span>
        Health <span className="text-cg-text">{a.health_score}</span>
        {a.health_grade && <span className="text-cg-tertiary"> ({a.health_grade})</span>}
      </span>
    );
  }
  if (a.status === 'error') return <span className="text-cg-sev-high">Failed</span>;
  return <span>Analyzing…</span>;
}

function Row({ a, signedIn, onShare, onRemove }) {
  const navigate = useNavigate();
  const path = openPath(a);
  const langs = topLanguages(a.languages);
  const status = StatusText({ a });
  const meta = [
    status && <span key="s">{status}</span>,
    langs.length ? <span key="l">{langs.join(', ')}</span> : null,
    <time key="d" dateTime={a.created_at}>{formatDate(a.created_at)}</time>,
    signedIn && a.shares > 0 ? <span key="sh">{a.shares} active link{a.shares === 1 ? '' : 's'}</span> : null,
  ].filter(Boolean);

  return (
    <li className="flex items-center gap-3 px-4 py-3 sm:px-5">
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
          {path ? (
            <Link to={path} className={cn('min-w-0 truncate rounded font-cg-mono text-cg-base text-cg-text hover:underline underline-offset-4', focusRing)}>
              {a.repo}
            </Link>
          ) : (
            <span className="min-w-0 truncate font-cg-mono text-cg-base text-cg-text">{a.repo}</span>
          )}
          {a.kind === 'pr' ? (
            <span className="h-5 shrink-0 rounded border border-cg-border-strong px-1.5 font-cg-mono text-cg-xs leading-[18px] text-cg-secondary">
              PR #{a.pr_number}
            </span>
          ) : (
            a.commit_sha && (
              <span className="h-5 shrink-0 rounded border border-cg-border px-1.5 font-cg-mono text-cg-xs leading-[18px] text-cg-tertiary">
                {a.commit_sha.slice(0, 8)}
              </span>
            )
          )}
        </div>
        {a.kind === 'pr' && a.pr_title && <p className="mt-0.5 truncate text-cg-sm text-cg-text">{a.pr_title}</p>}
        <p className="mt-1 flex flex-wrap gap-x-1.5 text-cg-sm text-cg-secondary">
          {meta.map((item, i) => (
            <span key={i} className="inline-flex items-center gap-1.5">
              {i > 0 && <span aria-hidden="true" className="text-cg-tertiary">·</span>}
              {item}
            </span>
          ))}
        </p>
      </div>
      {path && (
        <Link to={path} className={buttonClasses({ variant: 'secondary', size: 'sm', className: 'hidden sm:inline-flex' })}>
          Open
        </Link>
      )}
      <Menu>
        <MenuTrigger asChild>
          <IconButton label={`Actions for ${a.repo}`} tooltip={false}>
            <Ellipsis {...icon} />
          </IconButton>
        </MenuTrigger>
        <MenuContent align="end">
          {path && (
            <MenuItem icon={<ExternalLink {...icon} />} onSelect={() => navigate(path)}>
              Open
            </MenuItem>
          )}
          {a.status === 'done' && (
            <MenuItem icon={<Share2 {...icon} />} onSelect={() => onShare(a)}>
              {signedIn ? 'Share…' : 'Sign in to share'}
            </MenuItem>
          )}
          <MenuSeparator />
          <MenuItem icon={<Trash2 {...icon} />} onSelect={() => onRemove(a)} className="text-cg-sev-high">
            Remove from list
          </MenuItem>
        </MenuContent>
      </Menu>
    </li>
  );
}

export default function AnalysesView() {
  const navigate = useNavigate();
  const session = useSession();
  const [data, setData] = useState(null);
  const [state, setState] = useState('loading'); // loading | ready | error
  const [sharing, setSharing] = useState(null);
  const [removing, setRemoving] = useState(null);
  const [removeBusy, setRemoveBusy] = useState(false);
  const [notice, setNotice] = useState('');

  const load = useCallback(async () => {
    setState('loading');
    try {
      setData(await fetchMyAnalyses());
      setState('ready');
    } catch {
      setState('error');
    }
  }, []);

  useEffect(() => {
    document.title = 'CodeGraph — My analyses';
  }, []);
  // Reload when sign-in state settles (an anonymous list becomes the user's after signing in)
  useEffect(() => {
    if (session.status !== 'loading') load();
  }, [session.status, load]);

  const signedIn = session.status === 'signed_in';
  const analyses = data?.analyses ?? [];

  const share = (a) => {
    if (signedIn) setSharing(a);
    else signIn('/analyses');
  };

  const confirmRemove = async () => {
    setRemoveBusy(true);
    try {
      await removeMyAnalysis(removing.id);
      setData((d) => ({ ...d, analyses: d.analyses.filter((x) => x.id !== removing.id) }));
      setNotice(`${removing.repo} was removed from your list.`);
      setRemoving(null);
    } catch {
      setNotice(`Couldn't remove ${removing.repo}. Try again in a minute.`);
      setRemoving(null);
    } finally {
      setRemoveBusy(false);
    }
  };

  return (
    <div className="min-h-screen bg-cg-canvas font-cg-sans text-cg-text">
      <SiteNav showHowItWorks={false} />
      <main className="mx-auto w-full max-w-[880px] px-4 pb-16 pt-8 sm:px-6 sm:pt-12">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h1 className="text-cg-2xl font-semibold text-cg-text">My analyses</h1>
            <p className="mt-1 text-cg-sm text-cg-secondary">
              {signedIn ? 'Analyses you ran while signed in, newest first. Only you can open them.' : 'Analyses run in this browser, newest first.'}
            </p>
          </div>
          <Button variant="primary" onClick={() => navigate('/')}>
            Analyze a repo
          </Button>
        </div>

        {session.status === 'signed_out' && (
          <section aria-labelledby="keep-title" className="mt-6 rounded-cg-panel border border-cg-border bg-cg-raised p-5 shadow-cg-edge">
            <h2 id="keep-title" className="text-cg-base font-semibold text-cg-text">
              Sign in to keep your analyses
            </h2>
            <p className="mt-1 text-cg-sm text-cg-secondary">
              Without an account, this list lives in this browser only and is cleared after 7 days. Sign in with GitHub to keep it and to
              share analyses with a link. CodeGraph only reads your public profile.
            </p>
            <Button className="mt-4" onClick={() => signIn('/analyses')}>
              Sign in with GitHub
            </Button>
          </section>
        )}

        <p role="status" aria-live="polite" className={cn('text-cg-sm text-cg-secondary', notice ? 'mt-6' : 'sr-only')}>
          {notice}
        </p>

        <section aria-label="Analyses" className="mt-6">
          {state === 'loading' && (
            <p className="flex items-center gap-2 py-8 text-cg-sm text-cg-secondary">
              <Spinner label="Loading analyses" />
              <span aria-hidden="true">Loading analyses…</span>
            </p>
          )}
          {state === 'error' && (
            <div className="rounded-cg-panel border border-cg-border p-6 text-center">
              <p className="text-cg-sm text-cg-secondary">Couldn&apos;t load your analyses. The server may be waking up.</p>
              <Button className="mt-4" onClick={load}>
                Try again
              </Button>
            </div>
          )}
          {state === 'ready' && analyses.length === 0 && (
            <div className="rounded-cg-panel border border-cg-border px-6 py-10 text-center">
              <h2 className="text-cg-base font-semibold text-cg-text">No analyses yet</h2>
              <p className="mx-auto mt-1 max-w-sm text-cg-sm text-cg-secondary">
                Analyze a public GitHub repository and it shows up here, so you can come back to it.
              </p>
              <Button variant="primary" className="mt-5" onClick={() => navigate('/')}>
                Analyze a repo
              </Button>
            </div>
          )}
          {state === 'ready' && analyses.length > 0 && (
            <ul className="divide-y divide-cg-border rounded-cg-panel border border-cg-border bg-cg-raised">
              {analyses.map((a) => (
                <Row key={a.id} a={a} signedIn={signedIn} onShare={share} onRemove={setRemoving} />
              ))}
            </ul>
          )}
        </section>
      </main>

      <Dialog open={Boolean(removing)} onOpenChange={(open) => !open && setRemoving(null)}>
        {removing && (
          <DialogContent
            title={`Remove ${removing.repo} from your list?`}
            description="You won't be able to open this analysis from here again, and any share links to it stop working."
            footer={
              <>
                <DialogClose asChild>
                  <Button>Cancel</Button>
                </DialogClose>
                <Button variant="danger" loading={removeBusy} onClick={confirmRemove}>
                  Remove
                </Button>
              </>
            }
          />
        )}
      </Dialog>

      {sharing && (
        <ShareDialog
          open
          onOpenChange={(open) => {
            if (!open) {
              setSharing(null);
              load();
            }
          }}
          repo={sharing.repo}
          commitSha={sharing.commit_sha}
          userAnalysisId={sharing.id}
        />
      )}
    </div>
  );
}
