// /s/:token — an analysis opened from a share link: the app view, read-only (no Re-run, no
// Share). Chat, source and impact work: every request carries the link's token.
import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { Link2Off } from 'lucide-react';
import { fetchShare, setShareToken } from '../api';
import { buttonClasses, Spinner } from '../ui';
import { TopBarFrame } from '../components/app/AppTopBar';
import ShareableGraphView from './ShareableGraphView';

export default function SharedView() {
  const { token } = useParams();
  const [data, setData] = useState(null);
  const [state, setState] = useState('loading'); // loading | ready | gone

  useEffect(() => {
    let cancelled = false;
    setState('loading');
    setShareToken(token);
    fetchShare(token)
      .then((result) => {
        if (cancelled) return;
        setData(result);
        setState('ready');
      })
      .catch(() => {
        if (!cancelled) setState('gone');
      });
    return () => {
      cancelled = true;
      setShareToken(null);
    };
  }, [token]);

  useEffect(() => {
    if (state === 'gone') document.title = 'CodeGraph — Link not available';
  }, [state]);

  if (state === 'ready') {
    return (
      <ShareableGraphView
        key={token}
        staticData={data.graph}
        shared={{ sharedBy: data.share.shared_by, expiresAt: data.share.expires_at }}
      />
    );
  }

  return (
    <div className="flex h-dvh flex-col bg-cg-canvas font-cg-sans text-cg-text">
      <TopBarFrame />
      <div className="flex flex-1 items-center justify-center p-6">
        {state === 'loading' ? (
          <p className="flex items-center gap-2 text-cg-sm text-cg-secondary">
            <Spinner label="Opening shared analysis" />
            <span aria-hidden="true">Opening shared analysis…</span>
          </p>
        ) : (
          <div className="max-w-sm text-center">
            <Link2Off size={24} strokeWidth={1.5} aria-hidden="true" className="mx-auto text-cg-tertiary" />
            <h1 className="mt-3 text-cg-lg font-semibold text-cg-text">This link is no longer available</h1>
            <p className="mt-1 text-cg-sm text-cg-secondary">
              It may have expired, or the person who shared it turned it off. Ask them for a new link, or analyze the repository yourself.
            </p>
            <div className="mt-5 flex flex-wrap justify-center gap-2">
              <Link to="/" className={buttonClasses({ variant: 'primary' })}>
                Analyze a repo
              </Link>
              <Link to="/demo" className={buttonClasses({ variant: 'secondary' })}>
                View the demo
              </Link>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
