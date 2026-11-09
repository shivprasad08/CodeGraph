import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowRight } from 'lucide-react';
import { DEMO_DATA_URL, DEMO_REPO } from '../../lib/demo';
import { formatCount, graphStats } from '../../lib/graphStats';
import { buttonClasses, Spinner } from '../../ui';

// react-force-graph lives in this chunk; it is requested only when the section nears the viewport
const DemoGraph = lazy(() => import('./DemoGraph'));


/** Caption numbers come from the graph JSON, never hardcoded. */
export function DemoCaption({ graph }) {
  if (!graph) {
    return <span className="text-cg-tertiary">Graph of {DEMO_REPO.split('/')[1]}</span>;
  }
  const s = graphStats(graph);
  const num = (n) => <span className="font-cg-mono">{formatCount(n)}</span>;
  return (
    <span className="text-cg-tertiary">
      {s.name} · {num(s.files)} files · {num(s.nodes)} nodes · {num(s.edges)} edges
    </span>
  );
}

function Poster({ state }) {
  return (
    <div className="absolute inset-0 flex items-center justify-center gap-2 text-cg-sm text-cg-tertiary">
      {state === 'loading' && <Spinner label="Loading graph" />}
      {state === 'loading' && <span aria-hidden="true">Loading graph</span>}
      {state === 'idle' && <span>The interactive graph loads as you scroll</span>}
      {state === 'error' && <span>The demo graph didn&apos;t load. Reload the page to try again.</span>}
    </div>
  );
}

export default function LiveDemo() {
  const sectionRef = useRef(null);
  const [near, setNear] = useState(false);
  const [graph, setGraph] = useState(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (near || !sectionRef.current) return undefined;
    if (typeof IntersectionObserver === 'undefined') {
      setNear(true);
      return undefined;
    }
    const section = sectionRef.current;
    let observer;
    let cancelled = false;
    const observe = () => {
      if (cancelled) return;
      observer = new IntersectionObserver(
        ([entry]) => {
          if (entry.isIntersecting) {
            setNear(true);
            observer.disconnect();
          }
        },
        { rootMargin: '200px 0px' },
      );
      observer.observe(section);
    };
    // Start watching only once the page has loaded and the main thread is idle, so the
    // graph chunk and JSON never compete with the hero's first paint
    const afterLoad = () =>
      'requestIdleCallback' in window ? window.requestIdleCallback(observe, { timeout: 2000 }) : setTimeout(observe, 200);
    if (document.readyState === 'complete') afterLoad();
    else window.addEventListener('load', afterLoad, { once: true });
    return () => {
      cancelled = true;
      observer?.disconnect();
      window.removeEventListener('load', afterLoad);
    };
  }, [near]);

  useEffect(() => {
    if (!near) return undefined;
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
  }, [near]);

  const posterState = failed ? 'error' : near ? 'loading' : 'idle';

  return (
    <section ref={sectionRef} id="demo" aria-labelledby="demo-title" className="mx-auto w-full max-w-[1120px] px-4 sm:px-6">
      <h2 id="demo-title" className="sr-only">
        Live demo: the graph of {DEMO_REPO}
      </h2>
      <div className="overflow-hidden rounded-cg-panel border border-cg-border bg-cg-raised shadow-cg-edge">
        <div className="flex h-9 items-center justify-between gap-3 border-b border-cg-border px-3 font-cg-mono text-cg-xs">
          <span className="truncate text-cg-secondary">{DEMO_REPO}</span>
          {graph?.commit_sha && <span className="shrink-0 text-cg-tertiary">{graph.commit_sha}</span>}
        </div>
        <div
          role="img"
          aria-label={`Interactive dependency graph of ${DEMO_REPO}. Use “Explore the full graph” for the keyboard-accessible app view.`}
          className="relative h-[360px] bg-cg-canvas md:h-[520px]"
        >
          {graph ? (
            <Suspense fallback={<Poster state="loading" />}>
              <DemoGraph graph={graph} />
            </Suspense>
          ) : (
            <Poster state={posterState} />
          )}
        </div>
      </div>
      <div className="mt-4 flex flex-col items-start gap-3 sm:flex-row sm:items-center sm:justify-between">
        <p className="text-cg-sm" data-testid="demo-caption">
          <DemoCaption graph={graph} />
        </p>
        <Link to="/demo" className={buttonClasses({ variant: 'ghost', size: 'md', className: '-ml-4 gap-2 sm:ml-0' })}>
          Explore the full graph
          <ArrowRight size={16} strokeWidth={1.5} aria-hidden="true" />
        </Link>
      </div>
    </section>
  );
}
