// Share an analysis: pick an expiry, create a link, copy it; list existing links (views,
// expiry) and revoke them. A link's address is shown once, right after it is created — the
// server keeps only a hash of it.
import { useCallback, useEffect, useState } from 'react';
import { Check, Copy } from 'lucide-react';
import { createShare, fetchMyAnalyses, listShares, revokeShare } from '../../api';
import { cn } from '../../lib/cn';
import { Button, Dialog, DialogClose, DialogContent, Spinner, focusRing } from '../../ui';
import SegmentedControl from '../../ui/SegmentedControl';

const EXPIRY = [
  { value: '7', label: '7 days' },
  { value: '30', label: '30 days' },
  { value: 'never', label: 'Never' },
];

const dateFormat = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
export const formatDate = (iso) => (iso ? dateFormat.format(new Date(iso)) : '');

function linkSummary(link) {
  const parts = [`Created ${formatDate(link.created_at)}`];
  if (link.revoked_at) parts.push('turned off');
  else if (!link.active) parts.push(`expired ${formatDate(link.expires_at)}`);
  else parts.push(link.expires_at ? `expires ${formatDate(link.expires_at)}` : 'never expires');
  parts.push(`${link.view_count} view${link.view_count === 1 ? '' : 's'}`);
  return parts.join(' · ');
}

/** The user's history entry for this analysis: by job id, else by repo@commit. */
export async function findUserAnalysis({ userAnalysisId, jobId, repo, commitSha }) {
  if (userAnalysisId) return userAnalysisId;
  const { analyses } = await fetchMyAnalyses();
  const match =
    analyses.find((a) => jobId && a.job_id === jobId) ||
    analyses.find((a) => a.repo?.toLowerCase() === repo?.toLowerCase() && a.commit_sha === commitSha);
  return match?.id ?? null;
}

function CopyField({ url }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return undefined;
    const t = setTimeout(() => setCopied(false), 2000);
    return () => clearTimeout(t);
  }, [copied]);
  return (
    <div className="flex gap-2">
      <input
        readOnly
        value={url}
        aria-label="Share link"
        onFocus={(e) => e.target.select()}
        className={cn(
          'h-9 min-w-0 flex-1 rounded-cg-control border border-cg-border-strong bg-cg-canvas px-2.5 font-cg-mono text-cg-xs text-cg-text',
          focusRing,
        )}
      />
      <Button
        size="md"
        variant="secondary"
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(url);
            setCopied(true);
          } catch {
            setCopied(false);
          }
        }}
        leadingIcon={copied ? <Check size={16} strokeWidth={1.5} aria-hidden="true" /> : <Copy size={16} strokeWidth={1.5} aria-hidden="true" />}
      >
        <span className="inline-grid">
          <span className={cn('col-start-1 row-start-1', copied && 'invisible')}>Copy</span>
          <span className={cn('col-start-1 row-start-1', !copied && 'invisible')}>Copied</span>
        </span>
      </Button>
      <span className="sr-only" aria-live="polite">
        {copied ? 'Link copied' : ''}
      </span>
    </div>
  );
}

function RevokeButton({ onConfirm }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <Button size="sm" variant="danger" onClick={() => setOpen(true)}>
        Revoke
      </Button>
      <DialogContent
        title="Revoke this link?"
        description="Anyone who opens it will see that it's no longer available. This can't be undone; you can create a new link."
        footer={
          <>
            <DialogClose asChild>
              <Button>Cancel</Button>
            </DialogClose>
            <Button
              variant="danger"
              loading={busy}
              onClick={async () => {
                setBusy(true);
                try {
                  await onConfirm();
                  setOpen(false);
                } finally {
                  setBusy(false);
                }
              }}
            >
              Revoke link
            </Button>
          </>
        }
      />
    </Dialog>
  );
}

/**
 * @param {boolean} props.open
 * @param {(open: boolean) => void} props.onOpenChange
 * @param {string} props.repo "owner/repo"
 * @param {string} [props.commitSha]
 * @param {string} [props.jobId]
 * @param {string} [props.userAnalysisId] Known history entry (skips the lookup).
 */
export default function ShareDialog({ open, onOpenChange, repo, commitSha, jobId, userAnalysisId: knownId }) {
  const [userAnalysisId, setUserAnalysisId] = useState(knownId ?? null);
  const [phase, setPhase] = useState('loading'); // loading | ready | missing | error
  const [links, setLinks] = useState([]);
  const [expiry, setExpiry] = useState('7');
  const [creating, setCreating] = useState(false);
  const [created, setCreated] = useState(null);
  const [problem, setProblem] = useState('');

  const refresh = useCallback(async (id) => setLinks(await listShares(id)), []);

  useEffect(() => {
    if (!open) return undefined;
    let cancelled = false;
    setPhase('loading');
    setCreated(null);
    setProblem('');
    (async () => {
      try {
        const id = await findUserAnalysis({ userAnalysisId: knownId, jobId, repo, commitSha });
        if (cancelled) return;
        if (!id) {
          setPhase('missing');
          return;
        }
        setUserAnalysisId(id);
        const existing = await listShares(id);
        if (cancelled) return;
        setLinks(existing);
        setPhase('ready');
      } catch {
        if (!cancelled) setPhase('error');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, knownId, jobId, repo, commitSha]);

  const create = async () => {
    setCreating(true);
    setProblem('');
    try {
      const link = await createShare(userAnalysisId, expiry === 'never' ? null : Number(expiry));
      setCreated(`${window.location.origin}${link.url}`);
      await refresh(userAnalysisId).catch(() => {});
    } catch {
      setProblem("Couldn't create the link. Try again in a minute.");
    } finally {
      setCreating(false);
    }
  };

  const revoke = async (id) => {
    try {
      await revokeShare(id);
      await refresh(userAnalysisId);
    } catch {
      setProblem("Couldn't revoke the link. Try again in a minute.");
    }
  };

  const active = links.filter((l) => l.active);
  const inactive = links.filter((l) => !l.active);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        title={`Share ${repo}`}
        description="Anyone with the link can open this analysis and use its chat, source and impact tools. They can't re-run it or share it further."
        className="max-w-lg"
      >
        {phase === 'loading' && (
          <p className="flex items-center gap-2 py-4 text-cg-secondary">
            <Spinner label="Loading links" />
            <span aria-hidden="true">Loading links…</span>
          </p>
        )}
        {phase === 'missing' && (
          <p className="py-2 text-cg-secondary">
            This analysis isn&apos;t in your list, so it can&apos;t be shared. Run it again while signed in to add it.
          </p>
        )}
        {phase === 'error' && <p className="py-2 text-cg-secondary">Couldn&apos;t load your links. Close this and try again in a minute.</p>}
        {phase === 'ready' && (
          <div className="flex flex-col gap-5 pb-3">
            <section aria-labelledby="share-new" className="flex flex-col gap-3">
              <h3 id="share-new" className="text-cg-sm font-medium text-cg-text">
                New link
              </h3>
              <div className="flex flex-wrap items-center gap-3">
                <span id="share-expiry" className="text-cg-sm text-cg-secondary">
                  Expires after
                </span>
                <SegmentedControl label="Link expires after" options={EXPIRY} value={expiry} onChange={setExpiry} className="shadow-none" />
              </div>
              {created ? (
                <div className="flex flex-col gap-1.5">
                  <CopyField url={created} />
                  <p className="text-cg-xs text-cg-tertiary">Copy it now: for privacy, the full link isn&apos;t shown again.</p>
                </div>
              ) : (
                <div>
                  <Button variant="primary" onClick={create} loading={creating}>
                    Create link
                  </Button>
                </div>
              )}
              {created && (
                <div>
                  <Button size="sm" variant="ghost" onClick={() => setCreated(null)}>
                    Create another link
                  </Button>
                </div>
              )}
              {problem && (
                <p role="alert" className="text-cg-sm text-cg-sev-high">
                  {problem}
                </p>
              )}
            </section>

            <section aria-labelledby="share-existing" className="flex flex-col gap-2">
              <h3 id="share-existing" className="text-cg-sm font-medium text-cg-text">
                Links {active.length > 0 && <span className="font-normal text-cg-tertiary">({active.length} active)</span>}
              </h3>
              {links.length === 0 ? (
                <p className="text-cg-sm text-cg-tertiary">No links yet.</p>
              ) : (
                <ul className="flex flex-col divide-y divide-cg-border rounded-cg-control border border-cg-border">
                  {[...active, ...inactive].map((link) => (
                    <li key={link.id} className="flex items-center gap-3 px-3 py-2">
                      <span className={cn('min-w-0 flex-1 text-cg-sm', link.active ? 'text-cg-secondary' : 'text-cg-tertiary')}>
                        {linkSummary(link)}
                      </span>
                      {link.active && <RevokeButton onConfirm={() => revoke(link.id)} />}
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
