import { languageBreakdown } from '../lib/languages';
import { useMemo, useState } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { cn } from '../lib/cn';
import { Badge, focusRing } from '../ui';

const SEV_RANK = { high: 3, medium: 2, low: 1, info: 0 };
const SEV_DOT = { high: 'bg-cg-sev-high', medium: 'bg-cg-sev-med', low: 'bg-cg-sev-low', info: 'bg-cg-sev-low' };
const SEV_TONE = { high: 'high', medium: 'med', low: 'low' };
const VERDICT = { A: 'Excellent', B: 'Good', C: 'Fair', D: 'Poor', F: 'Needs attention' };
const GROUPS_OPEN_BY_DEFAULT = 3;

const sentenceCase = (s = '') => {
  const t = String(s).replace(/_/g, ' ');
  return t.charAt(0).toUpperCase() + t.slice(1).toLowerCase();
};

function verdictLine(grade, counts) {
  const v = VERDICT[grade] ?? 'Health score';
  if (counts.high) return `${v} · ${counts.high} high-severity ${counts.high === 1 ? 'issue' : 'issues'} to fix`;
  if (counts.medium) return `${v} · ${counts.medium} medium ${counts.medium === 1 ? 'issue' : 'issues'} to review`;
  if (counts.low) return `${v} · ${counts.low} low-priority ${counts.low === 1 ? 'note' : 'notes'}`;
  return `${v} · no issues found`;
}

/** 64px ring: track in the border colour, progress in the text colour. No traffic lights. */
export function ScoreRing({ score }) {
  const r = 28;
  const c = 2 * Math.PI * r;
  return (
    <svg width="64" height="64" viewBox="0 0 64 64" aria-hidden="true" className="shrink-0 -rotate-90">
      <circle cx="32" cy="32" r={r} fill="none" stroke="var(--cg-border-strong)" strokeWidth="4" />
      <circle
        cx="32"
        cy="32"
        r={r}
        fill="none"
        stroke="var(--cg-text)"
        strokeWidth="4"
        strokeLinecap="round"
        strokeDasharray={c}
        strokeDashoffset={c * (1 - Math.max(0, Math.min(100, score)) / 100)}
      />
    </svg>
  );
}

function HealthSkeleton() {
  return (
    <div className="flex flex-col gap-6 p-4" aria-busy="true" aria-label="Loading health analysis">
      <div className="flex items-center gap-4">
        <div className="h-16 w-16 rounded-full border-4 border-cg-hover" />
        <div className="flex flex-1 flex-col gap-2">
          <div className="h-7 w-24 rounded bg-cg-hover" />
          <div className="h-4 w-44 rounded bg-cg-hover" />
        </div>
      </div>
      <div className="grid grid-cols-3 gap-3">
        {Array.from({ length: 6 }, (_, i) => (
          <div key={i} className="h-9 rounded bg-cg-hover" />
        ))}
      </div>
      {Array.from({ length: 4 }, (_, i) => (
        <div key={i} className="h-12 rounded bg-cg-hover" />
      ))}
    </div>
  );
}

/**
 * Health tab.
 * @param {(node) => void} props.onNodeSelect Select a node (zoom + Details).
 * @param {(node, line?) => void} props.onViewSource Open the code view at a line.
 */
const percent = (share) => (share > 0 && share < 0.01 ? '<1%' : `${Math.round(share * 100)}%`);
const LANG_COLOR = (i) => `var(--cg-cluster-${(i % 8) + 1})`;

/** Share of each language (by lines of code; by files for older graphs). */
export function LanguageBar({ graph }) {
  const rows = languageBreakdown(graph);
  if (!rows.length) return null;
  const summary = rows.map((r) => `${r.name} ${percent(r.share)}`).join(', ');
  return (
    <section>
      <h3 className="text-cg-xs font-medium text-cg-secondary">Languages</h3>
      <div role="img" aria-label={summary} className="mt-2 flex h-2 overflow-hidden rounded-full bg-cg-raised">
        {rows.map((r, i) => (
          <span key={r.lang} style={{ width: `${r.share * 100}%`, backgroundColor: LANG_COLOR(i) }} />
        ))}
      </div>
      <ul className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-cg-xs" aria-hidden="true">
        {rows.map((r, i) => (
          <li key={r.lang} className="flex items-center gap-1.5">
            <span className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: LANG_COLOR(i) }} />
            <span className="text-cg-text">{r.name}</span>
            <span className="tabular-nums text-cg-secondary">{percent(r.share)}</span>
            <span className="tabular-nums text-cg-tertiary">
              · {r.files} {r.files === 1 ? 'file' : 'files'}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

export default function HealthPanel({ analysis, graph, isLoading, onNodeSelect, onViewSource }) {
  const [filter, setFilter] = useState('all');
  const [openGroups, setOpenGroups] = useState(null); // null = default set

  const issues = analysis?.issues ?? [];
  const counts = useMemo(
    () => ({
      high: issues.filter((i) => i.severity === 'high').length,
      medium: issues.filter((i) => i.severity === 'medium').length,
      low: issues.filter((i) => i.severity === 'low').length,
    }),
    [issues],
  );

  const groups = useMemo(() => {
    const byFile = new Map();
    for (const issue of issues) {
      if (!byFile.has(issue.file)) byFile.set(issue.file, { file: issue.file, severity: issue.severity, issues: [] });
      const g = byFile.get(issue.file);
      g.issues.push(issue);
      if ((SEV_RANK[issue.severity] ?? 0) > (SEV_RANK[g.severity] ?? 0)) g.severity = issue.severity;
    }
    return [...byFile.values()]
      .map((g) => ({ ...g, issues: [...g.issues].sort((a, b) => (SEV_RANK[b.severity] ?? 0) - (SEV_RANK[a.severity] ?? 0) || (a.line ?? 0) - (b.line ?? 0)) }))
      .sort((a, b) => (SEV_RANK[b.severity] ?? 0) - (SEV_RANK[a.severity] ?? 0) || b.issues.length - a.issues.length || a.file.localeCompare(b.file));
  }, [issues]);

  const visibleGroups = useMemo(
    () =>
      filter === 'all'
        ? groups
        : groups.map((g) => ({ ...g, issues: g.issues.filter((i) => i.severity === filter) })).filter((g) => g.issues.length),
    [groups, filter],
  );

  if (isLoading || !analysis) return <HealthSkeleton />;

  const isOpen = (file, index) => (openGroups ? openGroups.has(file) : index < GROUPS_OPEN_BY_DEFAULT);
  const toggleGroup = (file, index) =>
    setOpenGroups((prev) => {
      const base = prev ?? new Set(visibleGroups.slice(0, GROUPS_OPEN_BY_DEFAULT).map((g) => g.file));
      const next = new Set(base);
      if (isOpen(file, index)) next.delete(file);
      else next.add(file);
      return next;
    });

  const nodeForIssue = (issue) =>
    graph?.nodes?.find((n) => issue.function && n.label === issue.function && n.file === issue.file) ||
    graph?.nodes?.find((n) => n.id === issue.file);

  const m = analysis.metrics ?? {};
  const stats = [
    ['Files', m.total_files],
    ['Functions', m.total_functions],
    ['Classes', m.total_classes],
    ['Avg lines/fn', m.avg_function_length != null ? Math.round(m.avg_function_length) : null],
    ['Dead code', m.dead_code_count],
    ['Circular imports', m.circular_import_count],
  ];
  const fileNodes = (graph?.nodes ?? []).filter((n) => n.type === 'file');
  const linkBtn = cn('rounded text-cg-xs text-cg-secondary underline-offset-4 hover:text-cg-text hover:underline [@media(pointer:coarse)]:min-h-11', focusRing);

  return (
    <div className="flex flex-col gap-6 p-4">
      <section className="flex items-center gap-4" aria-label="Health score">
        <ScoreRing score={analysis.score} />
        <div className="min-w-0">
          <p className="text-cg-2xl font-semibold text-cg-text">
            <span className="tabular-nums">{analysis.score}</span>
            <span className="text-cg-tertiary"> · </span>
            {analysis.grade}
          </p>
          <p className="text-cg-sm text-cg-secondary">{verdictLine(analysis.grade, counts)}</p>
        </div>
      </section>

      <dl className="grid grid-cols-3 gap-x-3 gap-y-3">
        {stats.map(([label, value]) => (
          <div key={label} className="min-w-0">
            <dt className="truncate text-cg-xs text-cg-tertiary">{label}</dt>
            <dd className="text-cg-base tabular-nums text-cg-text">{value ?? 0}</dd>
          </div>
        ))}
      </dl>

      <LanguageBar graph={graph} />

      {analysis.patterns?.length > 0 && (
        <section>
          <h3 className="text-cg-xs font-medium text-cg-secondary">Patterns</h3>
          <ul className="mt-2 flex flex-col gap-2">
            {analysis.patterns.map((p, i) => (
              <li key={i} className="text-cg-sm">
                <span className="text-cg-text">{p.name}</span>
                <span className="text-cg-tertiary"> · {p.file?.split('/').pop()}</span>
                {p.description && <p className="text-cg-xs text-cg-secondary">{p.description}</p>}
              </li>
            ))}
          </ul>
        </section>
      )}

      <section>
        <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label="Filter issues by severity">
          <Badge onClick={() => setFilter('all')} selected={filter === 'all'}>
            All <span className="tabular-nums">{issues.length}</span>
          </Badge>
          {['high', 'medium', 'low'].map((sev) => (
            <Badge key={sev} tone={SEV_TONE[sev]} onClick={() => setFilter(sev)} selected={filter === sev}>
              {sentenceCase(sev)} <span className="tabular-nums">{counts[sev]}</span>
            </Badge>
          ))}
        </div>

        {visibleGroups.length === 0 ? (
          <p className="mt-4 text-cg-sm text-cg-tertiary">{issues.length ? 'No issues at this severity.' : 'No issues found.'}</p>
        ) : (
          <ul className="mt-3 flex flex-col">
            {visibleGroups.map((g, gi) => {
              const open = isOpen(g.file, gi);
              const Chevron = open ? ChevronDown : ChevronRight;
              return (
                <li key={g.file} className="border-t border-cg-border first:border-t-0">
                  <button
                    type="button"
                    aria-expanded={open}
                    onClick={() => toggleGroup(g.file, gi)}
                    title={g.file}
                    className={cn('flex h-9 w-full items-center gap-2 rounded text-left text-cg-sm [@media(pointer:coarse)]:min-h-11', focusRing)}
                  >
                    <Chevron size={16} strokeWidth={1.5} aria-hidden="true" className="shrink-0 text-cg-tertiary" />
                    <span aria-hidden="true" className={cn('h-1.5 w-1.5 shrink-0 rounded-full', SEV_DOT[g.severity])} />
                    <span className="min-w-0 flex-1 truncate text-cg-text">{g.file.split('/').pop()}</span>
                    <span className="shrink-0 tabular-nums text-cg-xs text-cg-tertiary">{g.issues.length}</span>
                  </button>
                  {open && (
                    <ul className="flex flex-col gap-3 pb-3 pl-6">
                      {g.issues.map((issue, ii) => {
                        const node = nodeForIssue(issue);
                        return (
                          <li key={issue.id ?? `${g.file}-${ii}`} className="text-cg-sm">
                            <p className="flex items-center gap-1.5 text-cg-xs text-cg-tertiary">
                              <span aria-hidden="true" className={cn('h-1.5 w-1.5 rounded-full', SEV_DOT[issue.severity])} />
                              <span className="sr-only">{sentenceCase(issue.severity)} severity, </span>
                              {sentenceCase(issue.type)}
                              {issue.line != null && <span className="ml-auto font-cg-mono">line {issue.line}</span>}
                            </p>
                            <p className="mt-0.5 text-cg-text">{issue.message}</p>
                            {issue.function && <p className="font-cg-mono text-cg-xs text-cg-tertiary">in {issue.function}</p>}
                            {node && (
                              <p className="mt-1 flex gap-3">
                                <button type="button" className={linkBtn} onClick={() => onNodeSelect(node)}>
                                  Show in graph
                                </button>
                                <button type="button" className={linkBtn} onClick={() => onViewSource(node, issue.line)}>
                                  View source
                                </button>
                              </p>
                            )}
                          </li>
                        );
                      })}
                    </ul>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </section>

      {fileNodes.length > 0 && (
        <section>
          <h3 className="text-cg-xs font-medium text-cg-secondary">File health</h3>
          <ul className="mt-2 flex flex-wrap gap-x-3 gap-y-1">
            {fileNodes.map((fn) => {
              const sev = analysis.by_file?.[fn.id]?.severity;
              return (
                <li key={fn.id}>
                  <button
                    type="button"
                    title={`${fn.id}${sev ? ` · worst issue: ${sev}` : ' · no issues'}`}
                    onClick={() => onNodeSelect(fn)}
                    className={cn('inline-flex items-center gap-1.5 rounded text-cg-xs text-cg-secondary hover:text-cg-text [@media(pointer:coarse)]:min-h-11', focusRing)}
                  >
                    <span aria-hidden="true" className={cn('h-1.5 w-1.5 rounded-full', sev ? SEV_DOT[sev] : 'bg-cg-success')} />
                    {fn.id.split('/').pop()}
                  </button>
                </li>
              );
            })}
          </ul>
        </section>
      )}
    </div>
  );
}
