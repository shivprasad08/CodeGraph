// PR risk: monochrome score ring, the level word in its severity colour, and every factor
// with its points and a one-line reason (the score is their sum, capped at 100).
import { cn } from '../../lib/cn';
import { RISK_LEVEL } from '../../lib/risk';
import { ScoreRing } from '../HealthPanel';

export default function RiskCard({ risk }) {
  const level = RISK_LEVEL[risk.level] ?? RISK_LEVEL.low;
  return (
    <section aria-labelledby="risk-title" className="rounded-cg-panel border border-cg-border bg-cg-raised p-4">
      <h2 id="risk-title" className="sr-only">
        Risk
      </h2>
      <div className="flex items-center gap-4">
        <div className="relative">
          <ScoreRing score={risk.score} />
          <span className="absolute inset-0 flex items-center justify-center font-cg-mono text-cg-base font-semibold text-cg-text">
            {risk.score}
          </span>
        </div>
        <div>
          <p className={cn('text-cg-lg font-semibold', level.className)}>{level.word}</p>
          <p className="text-cg-xs text-cg-tertiary">Score {risk.score} of 100 · the sum of the factors below</p>
        </div>
      </div>
      <ul className="mt-4 flex flex-col divide-y divide-cg-border" aria-label="Risk factors">
        {risk.factors.map((f) => (
          <li key={f.key} className="flex gap-3 py-2">
            <div className="min-w-0 flex-1">
              <p className={cn('text-cg-sm font-medium', f.points ? 'text-cg-text' : 'text-cg-secondary')}>{f.label}</p>
              <p className="text-cg-xs text-cg-secondary">{f.reason}</p>
            </div>
            <p className="shrink-0 text-right font-cg-mono text-cg-sm">
              <span className={f.points ? 'text-cg-text' : 'text-cg-tertiary'}>+{f.points}</span>
              <span className="block text-cg-xs text-cg-tertiary">of {f.max}</span>
            </p>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** Plain text with `code` spans (the model may quote identifiers in backticks). */
export function InlineCode({ text }) {
  const parts = String(text ?? '').split(/(`[^`\n]+`)/g);
  return parts.map((part, i) =>
    part.startsWith('`') && part.endsWith('`') && part.length > 2 ? (
      <code key={i} className="break-all rounded bg-cg-hover px-1 font-cg-mono text-[0.92em] text-cg-text">
        {part.slice(1, -1)}
      </code>
    ) : (
      <span key={i}>{part}</span>
    ),
  );
}

export function SummaryBlock({ summary }) {
  return (
    <section aria-labelledby="summary-title" className="rounded-cg-panel border border-cg-border bg-cg-raised p-4">
      <h2 id="summary-title" className="text-cg-sm font-semibold text-cg-text">
        Summary
      </h2>
      <p className="mt-1.5 text-cg-sm leading-relaxed text-cg-secondary">
        <InlineCode text={summary?.text} />
      </p>
      <p className="mt-2 text-cg-xs text-cg-tertiary">
        {summary?.source === 'ai' ? 'Written by AI from the facts in this analysis.' : 'Written from the analysis (AI summary unavailable).'}
      </p>
    </section>
  );
}
