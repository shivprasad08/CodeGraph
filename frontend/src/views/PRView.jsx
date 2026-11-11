// Page pattern: detail with split pane — header (PR, author, state, commits, actions); side
// column with risk and summary; main area with tabs (Changes, Blast radius, Architecture, Files).
// Under 1024px everything stacks and the page scrolls.
// Route /pr/:owner/:repo/:number/jobs/:jobId; also rendered by /s/:token for a shared PR.
import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { ExternalLink, FileX, GitPullRequest, Lock, Share2, TriangleAlert } from 'lucide-react';
import { fetchPR, subscribeToJob } from '../api';
import { cn } from '../lib/cn';
import { currentPath, signIn, useSession } from '../lib/session';
import { Button, Tabs, TabsContent, TabsList, TabsTrigger, focusRing } from '../ui';
import { TopBarFrame, SharedChip } from '../components/app/AppTopBar';
import ShareDialog from '../components/app/ShareDialog';
import AccountControl from '../components/AccountControl';
import Avatar from '../components/Avatar';
import GitHubMark from '../components/landing/GitHubMark';
import ProgressBar from '../components/ProgressBar';
import RiskCard, { SummaryBlock } from '../components/pr/RiskCard';
import ChangesTab from '../components/pr/ChangesTab';
import BlastRadiusTab from '../components/pr/BlastRadiusTab';
import PRArchitectureTab from '../components/pr/PRArchitectureTab';
import FilesTab from '../components/pr/FilesTab';

export const PR_STAGES = [
  { id: 'fetch_pr', label: 'Fetch PR' },
  { id: 'base', label: 'Base' },
  { id: 'head', label: 'Head' },
  { id: 'mapping', label: 'Map changes' },
  { id: 'scoring', label: 'Score' },
  { id: 'summary', label: 'Summarize' },
];

const STATE_LABEL = { open: 'Open', merged: 'Merged', closed: 'Closed' };

function CenterMessage({ icon, title, body, actions }) {
  return (
    <div className="flex flex-1 items-center justify-center p-6">
      <div className="max-w-sm text-center">
        {icon}
        <h1 className="mt-3 text-cg-lg font-semibold text-cg-text">{title}</h1>
        {body && <p className="mt-1 text-cg-sm text-cg-secondary">{body}</p>}
        {actions && <div className="mt-5 flex flex-wrap justify-center gap-2">{actions}</div>}
      </div>
    </div>
  );
}

const iconProps = { size: 24, strokeWidth: 1.5, 'aria-hidden': true, className: 'mx-auto text-cg-tertiary' };

function Header({ pr }) {
  return (
    <div className="border-b border-cg-border px-4 py-4 sm:px-6">
      <h1 className="text-cg-xl font-semibold text-cg-text">
        {pr.title} <span className="font-cg-mono font-normal text-cg-tertiary">#{pr.number}</span>
      </h1>
      <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-2 text-cg-sm text-cg-secondary">
        <span className="inline-flex h-6 items-center gap-1.5 rounded-cg-control border border-cg-border-strong px-2 text-cg-xs text-cg-text">
          <GitPullRequest size={14} strokeWidth={1.5} aria-hidden="true" />
          {STATE_LABEL[pr.state] ?? pr.state}
        </span>
        {pr.author && (
          <span className="inline-flex items-center gap-1.5">
            <Avatar user={{ login: pr.author, avatar_url: pr.author_avatar }} size={20} />
            {pr.author}
          </span>
        )}
        <span className="font-cg-mono text-cg-xs text-cg-tertiary">
          <span className="sr-only">Commits: base </span>
          {pr.base_sha?.slice(0, 8)} → {pr.head_sha?.slice(0, 8)}
          {pr.is_fork && pr.head_repo && <span> ({pr.head_repo})</span>}
        </span>
        <a
          href={pr.html_url}
          target="_blank"
          rel="noopener noreferrer"
          className={cn('inline-flex items-center gap-1 rounded text-cg-secondary underline-offset-4 hover:text-cg-text hover:underline [@media(pointer:coarse)]:min-h-11', focusRing)}
        >
          View on GitHub
          <ExternalLink size={14} strokeWidth={1.5} aria-hidden="true" />
          <span className="sr-only">(opens GitHub)</span>
        </a>
      </div>
    </div>
  );
}

/**
 * @param {object} [props.staticResult] A loaded PR result (shared view).
 * @param {object} [props.shared] { sharedBy, expiresAt } for a shared, read-only view.
 * @param {string} [props.jobId] Job id when not taken from the route.
 */
export default function PRView({ staticResult = null, shared = null, jobId: jobIdProp } = {}) {
  const params = useParams();
  const navigate = useNavigate();
  const session = useSession();
  const jobId = jobIdProp ?? params.jobId;
  const [result, setResult] = useState(staticResult);
  const [phase, setPhase] = useState(staticResult ? 'done' : 'analyzing'); // analyzing | done | error
  const [error, setError] = useState(null);
  const [errorCode, setErrorCode] = useState(null);
  const [progress, setProgress] = useState({ progress: 0, stage: 'queued', message: 'Queued' });
  const [startedAt] = useState(() => Date.now());
  const [tab, setTab] = useState('changes');
  const [selectedId, setSelectedId] = useState(null);
  const [shareOpen, setShareOpen] = useState(false);

  const owner = result?.pr?.owner ?? params.owner;
  const repo = result?.pr?.repo ?? params.repo;
  const number = result?.pr?.number ?? Number(params.number);
  const label = `${owner}/${repo}#${number}`;

  useEffect(() => {
    document.title = `CodeGraph — ${label}`;
  }, [label]);

  useEffect(() => {
    if (staticResult) return undefined;
    return subscribeToJob(
      jobId,
      (data) => setProgress({ progress: data.progress, stage: data.stage, message: data.message }),
      (message, code) => {
        setError(message);
        setErrorCode(code ?? null);
        setPhase('error');
      },
      async () => {
        try {
          setResult(await fetchPR(jobId));
          setPhase('done');
        } catch (err) {
          setError(err.message);
          setErrorCode(err.code ?? null);
          setPhase('error');
        }
      },
    );
  }, [jobId, staticResult]);

  const selectChange = (id) => {
    setSelectedId(id);
    setTab('blast');
  };

  const signedIn = session.status === 'signed_in';
  const crumb = (
    <span className="min-w-0 truncate font-cg-mono text-cg-sm text-cg-text">
      {owner}/{repo} <span className="text-cg-tertiary">#{number}</span>
    </span>
  );

  const actions = useMemo(
    () => (
      <div className="ml-auto flex shrink-0 items-center gap-1.5">
        {shared ? (
          <SharedChip shared={shared} className="hidden sm:inline-flex" />
        ) : (
          phase === 'done' && (
            <Button
              size="sm"
              variant="secondary"
              disabled={session.status === 'loading'}
              onClick={() => (signedIn ? setShareOpen(true) : signIn(currentPath()))}
              leadingIcon={signedIn ? <Share2 size={16} strokeWidth={1.5} aria-hidden="true" /> : <GitHubMark size={16} />}
            >
              {session.status === 'loading' ? 'Share' : signedIn ? 'Share' : 'Sign in to share'}
            </Button>
          )
        )}
        <AccountControl compact />
      </div>
    ),
    [shared, phase, session.status, signedIn],
  );

  if (phase === 'error') {
    let content;
    if (errorCode === 'private_analysis') {
      content = (
        <CenterMessage
          icon={<Lock {...iconProps} />}
          title="This analysis is private"
          body={
            session.status === 'signed_in'
              ? 'Only the person who ran it can open it, or someone they send a share link to. You can analyze this PR yourself.'
              : 'Only the person who ran it can open it, or someone they send a share link to. If you ran it, sign in with the GitHub account you used.'
          }
          actions={
            <>
              <Button variant="primary" onClick={() => navigate(`/?repo=${encodeURIComponent(`${owner}/${repo}/pull/${number}`)}`)}>
                Analyze this PR
              </Button>
              {session.status === 'signed_out' && <Button onClick={() => signIn(currentPath())}>Sign in</Button>}
            </>
          }
        />
      );
    } else if (errorCode === 'private_repo') {
      content = (
        <CenterMessage
          icon={<Lock {...iconProps} />}
          title="Private repositories aren't supported"
          body="CodeGraph only analyzes pull requests on public repositories (and, for a fork, a public fork)."
          actions={<Button variant="primary" onClick={() => navigate('/')}>Analyze another repo</Button>}
        />
      );
    } else if (errorCode === 'pr_too_large' || errorCode === 'no_source') {
      content = (
        <CenterMessage
          icon={<FileX {...iconProps} />}
          title={errorCode === 'pr_too_large' ? 'This repository is too large to analyze' : 'No source files CodeGraph can read'}
          body={String(error)}
          actions={<Button variant="primary" onClick={() => navigate('/')}>Analyze another repo</Button>}
        />
      );
    } else {
      content = (
        <CenterMessage
          icon={<TriangleAlert {...iconProps} />}
          title={errorCode === 'pr_not_found' ? 'Pull request not found' : `Couldn't analyze ${label}`}
          body={`${String(error || 'Something went wrong').replace(/\.\s*$/, '')}.`}
          actions={
            <>
              {errorCode !== 'pr_not_found' && (
                <Button variant="primary" onClick={() => window.location.reload()}>
                  Try again
                </Button>
              )}
              <Button onClick={() => navigate('/')}>Back to home</Button>
            </>
          }
        />
      );
    }
    return (
      <div className="flex h-dvh flex-col bg-cg-canvas font-cg-sans text-cg-text">
        <TopBarFrame repoLabel={crumb} />
        {content}
      </div>
    );
  }

  if (phase !== 'done' || !result) {
    return (
      <div className="flex h-dvh flex-col bg-cg-canvas font-cg-sans text-cg-text">
        <TopBarFrame repoLabel={crumb} />
        <div className="flex flex-1 items-center justify-center p-4">
          <ProgressBar
            progress={progress.progress}
            stage={progress.stage}
            message={progress.message}
            startedAt={startedAt}
            stages={PR_STAGES}
            title={
              <>
                Analyzing <span className="font-cg-mono font-medium">{label}</span>
              </>
            }
          />
        </div>
      </div>
    );
  }

  const { pr, risk, summary } = result;
  const quiet = (result.stats.docs ?? 0) + (result.stats.format ?? 0);
  return (
    <div className="flex min-h-dvh flex-col bg-cg-canvas font-cg-sans text-cg-text lg:h-dvh">
      <TopBarFrame repoLabel={crumb}>{actions}</TopBarFrame>
      <Header pr={pr} />
      {shared && (
        <p className="border-b border-cg-border px-4 py-2 text-cg-xs text-cg-secondary sm:hidden">
          <SharedChip shared={shared} />
        </p>
      )}
      <div className="flex min-h-0 flex-1 flex-col lg:flex-row">
        <aside aria-label="Risk and summary" className="flex flex-col gap-3 border-cg-border p-4 sm:px-6 lg:w-[380px] lg:shrink-0 lg:overflow-y-auto lg:border-r lg:px-4">
          {result.partial && (
            <p role="note" className="rounded-cg-control border border-cg-border bg-cg-raised px-3 py-2 text-cg-sm text-cg-secondary">
              Partial result: some files couldn&apos;t be mapped to the graph.{' '}
              <button type="button" className={cn('rounded underline underline-offset-4 hover:text-cg-text', focusRing)} onClick={() => setTab('files')}>
                See files
              </button>
            </p>
          )}
          <RiskCard risk={risk} />
          <SummaryBlock summary={summary} />
          <p className="text-cg-xs text-cg-tertiary">
            {result.stats.changed} code change{result.stats.changed === 1 ? '' : 's'}
            {quiet > 0 && ` · ${quiet} docs or format only`} · {result.stats.impacted} depend on them ·{' '}
            {result.stats.files} file{result.stats.files === 1 ? '' : 's'} in the PR
          </p>
        </aside>
        <main className="flex min-h-0 min-w-0 flex-1 flex-col px-4 pb-4 sm:px-6 lg:px-4">
          <Tabs value={tab} onValueChange={setTab} className="flex min-h-0 flex-1 flex-col">
            <TabsList aria-label="PR impact">
              <TabsTrigger value="changes">Changes</TabsTrigger>
              <TabsTrigger value="blast">Blast radius</TabsTrigger>
              <TabsTrigger value="architecture">Architecture</TabsTrigger>
              <TabsTrigger value="files">Files</TabsTrigger>
            </TabsList>
            <TabsContent value="changes" className="min-h-0 flex-1 lg:overflow-y-auto">
              <ChangesTab changes={result.changes} selectedId={selectedId} onSelect={selectChange} onShowFiles={() => setTab('files')} />
            </TabsContent>
            <TabsContent value="blast" className="flex min-h-0 flex-1 flex-col">
              <BlastRadiusTab result={result} jobId={jobId} selectedId={selectedId} onSelect={setSelectedId} onShowFiles={() => setTab('files')} />
            </TabsContent>
            <TabsContent value="architecture" className="flex min-h-0 flex-1 flex-col">
              <PRArchitectureTab result={result} />
            </TabsContent>
            <TabsContent value="files" className="min-h-0 flex-1 lg:overflow-y-auto">
              <FilesTab files={result.files} partial={result.partial} />
            </TabsContent>
          </Tabs>
        </main>
      </div>
      {!shared && signedIn && (
        <ShareDialog open={shareOpen} onOpenChange={setShareOpen} repo={label} commitSha={pr.head_sha?.slice(0, 8)} jobId={jobId} />
      )}
    </div>
  );
}
