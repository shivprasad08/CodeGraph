// /demo — the full graph app view on the saved mini_redis analysis. No backend calls.
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { DEMO_DATA_URL } from '../lib/demo';
import { buttonClasses, Spinner } from '../ui';
import ShareableGraphView from './ShareableGraphView';

export default function DemoView() {
  const [graph, setGraph] = useState(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetch(DEMO_DATA_URL)
      .then((res) => {
        if (!res.ok) throw new Error(String(res.status));
        return res.json();
      })
      .then((json) => !cancelled && setGraph(json))
      .catch(() => !cancelled && setFailed(true));
    return () => {
      cancelled = true;
    };
  }, []);

  if (graph) return <ShareableGraphView staticData={graph} />;

  return (
    <div className="flex h-dvh flex-col items-center justify-center gap-4 bg-cg-canvas font-cg-sans text-cg-sm text-cg-secondary">
      {failed ? (
        <>
          <p>The demo graph didn&apos;t load. Reload the page, or analyze a repository instead.</p>
          <Link to="/" className={buttonClasses({ variant: 'secondary' })}>
            Back to home
          </Link>
        </>
      ) : (
        <p className="flex items-center gap-2">
          <Spinner label="Loading demo graph" />
          <span aria-hidden="true">Loading demo graph</span>
        </p>
      )}
    </div>
  );
}
