import { useEffect, useState } from 'react';
import { Check } from 'lucide-react';
import { cn } from '../lib/cn';

const STAGES = [
  { id: 'ingestion', label: 'Fetch' },
  { id: 'parsing', label: 'Parse' },
  { id: 'graph', label: 'Map' },
  { id: 'enrichment', label: 'Summarize' },
  { id: 'done', label: 'Done' },
];

const formatElapsed = (sec) => `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;

/** Analysis progress for a running job: bar, stages, live message and elapsed time. */
export default function ProgressBar({ progress = 0, stage, message, startedAt, repo }) {
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    if (!startedAt) return undefined;
    const tick = () => setElapsed(Math.max(0, Math.floor((Date.now() - startedAt) / 1000)));
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [startedAt]);

  const current = Math.max(0, STAGES.findIndex((s) => s.id === stage || (stage === 'queued' && s.id === 'ingestion')));
  const pct = Math.max(0, Math.min(100, Math.round(progress || 0)));

  return (
    <section aria-labelledby="progress-title" className="w-full max-w-md rounded-cg-panel border border-cg-border bg-cg-raised p-6 font-cg-sans shadow-cg-edge">
      <h1 id="progress-title" className="text-cg-lg font-semibold text-cg-text">
        Analyzing {repo ? <span className="font-cg-mono font-medium">{repo}</span> : 'repository'}
      </h1>
      <p className="mt-1 text-cg-sm text-cg-secondary">The first request on the free tier can take up to a minute.</p>

      <div
        role="progressbar"
        aria-label="Analysis progress"
        aria-valuenow={pct}
        aria-valuemin={0}
        aria-valuemax={100}
        className="mt-5 h-1 overflow-hidden rounded-full bg-cg-hover"
      >
        <div className="h-full rounded-full bg-cg-text transition-[width] duration-cg-base ease-cg" style={{ width: `${pct}%` }} />
      </div>

      <ol className="mt-4 flex flex-wrap gap-x-4 gap-y-1 text-cg-xs">
        {STAGES.map((s, i) => (
          <li
            key={s.id}
            aria-current={i === current ? 'step' : undefined}
            className={cn('inline-flex items-center gap-1', i < current ? 'text-cg-secondary' : i === current ? 'font-medium text-cg-text' : 'text-cg-tertiary')}
          >
            {i < current && <Check size={12} strokeWidth={2} aria-hidden="true" />}
            {s.label}
          </li>
        ))}
      </ol>

      <div className="mt-4 flex items-baseline justify-between gap-4 text-cg-sm">
        <p aria-live="polite" className="min-w-0 truncate text-cg-secondary">
          {message || 'Queued'}
        </p>
        <p className="shrink-0 font-cg-mono text-cg-xs text-cg-tertiary">
          {pct}% · {formatElapsed(elapsed)}
        </p>
      </div>
    </section>
  );
}
