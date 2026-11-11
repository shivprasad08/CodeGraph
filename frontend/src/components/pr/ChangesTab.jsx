// Changes: every changed function/class, grouped by module. Selecting one shows it in Blast radius.
import { AlignLeft, FileText, FileX, Minus, PencilLine, Plus } from 'lucide-react';
import { cn } from '../../lib/cn';
import { Button, focusRing } from '../../ui';

export const CHANGE_KIND = {
  added: { label: 'Added', Icon: Plus, className: 'text-cg-success' },
  modified: { label: 'Modified', Icon: PencilLine, className: 'text-cg-sev-med' },
  removed: { label: 'Removed', Icon: Minus, className: 'text-cg-sev-high' },
  // Not code changes: shown for completeness, never scored or traced
  docs: { label: 'Docs only', Icon: FileText, className: 'text-cg-tertiary', quiet: true },
  format: { label: 'Format only', Icon: AlignLeft, className: 'text-cg-tertiary', quiet: true },
};

export const isCodeChange = (c) => !CHANGE_KIND[c.kind]?.quiet;

function groupByModule(changes) {
  const groups = new Map();
  for (const c of changes) {
    const key = c.module || 'Other files';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(c);
  }
  return [...groups.entries()];
}

export function EmptyChanges({ onShowFiles }) {
  return (
    <div className="flex flex-col items-center px-6 py-12 text-center">
      <FileX size={24} strokeWidth={1.5} aria-hidden="true" className="text-cg-tertiary" />
      <h3 className="mt-3 text-cg-base font-medium text-cg-text">This PR doesn&apos;t change any analysed source files</h3>
      <p className="mt-1 max-w-sm text-cg-sm text-cg-secondary">
        It only touches files outside the code graph (tests, docs, config) or lines outside functions and classes.
      </p>
      {onShowFiles && (
        <Button className="mt-4" size="sm" onClick={onShowFiles}>
          See files
        </Button>
      )}
    </div>
  );
}

export default function ChangesTab({ changes, selectedId, onSelect, onShowFiles }) {
  if (!changes.length) return <EmptyChanges onShowFiles={onShowFiles} />;
  return (
    <div className="flex flex-col gap-5">
      {groupByModule(changes).map(([module, items]) => (
        <section key={module} aria-label={`Module ${module}`}>
          <h3 className="mb-1.5 flex items-baseline gap-2 text-cg-sm font-medium text-cg-text">
            {module}
            <span className="text-cg-xs font-normal text-cg-tertiary">
              {items.length} change{items.length === 1 ? '' : 's'}
            </span>
          </h3>
          <ul className="flex flex-col divide-y divide-cg-border rounded-cg-control border border-cg-border">
            {items.map((c) => {
              const kind = CHANGE_KIND[c.kind] ?? CHANGE_KIND.modified;
              const selected = c.id === selectedId;
              return (
                <li key={c.id}>
                  <button
                    type="button"
                    onClick={() => onSelect(c.id)}
                    aria-pressed={selected}
                    className={cn(
                      'flex w-full items-start gap-3 px-3 py-2 text-left transition-colors duration-cg-fast ease-cg hover:bg-cg-hover',
                      selected && 'bg-cg-hover',
                      focusRing,
                    )}
                  >
                    <kind.Icon size={16} strokeWidth={1.5} aria-label={kind.label} className={cn('mt-0.5 shrink-0', kind.className)} />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-cg-mono text-cg-sm text-cg-text">{c.qualified_name}</span>
                      <span className="block truncate font-cg-mono text-cg-xs text-cg-tertiary">{c.file}</span>
                      {(c.signature_changed || c.breaking || kind.quiet) && (
                        <span className="mt-1 flex flex-wrap gap-1.5">
                          {kind.quiet && (
                            <span className="rounded border border-cg-border px-1.5 text-cg-xs text-cg-tertiary">{kind.label.toLowerCase()}</span>
                          )}
                          {c.signature_changed && (
                            <span className="rounded border border-cg-border-strong px-1.5 text-cg-xs text-cg-secondary">
                              Signature {c.params_before} → {c.params_after} params
                            </span>
                          )}
                          {c.breaking && (
                            <span className="rounded border border-cg-sev-high px-1.5 text-cg-xs text-cg-sev-high">Breaking</span>
                          )}
                        </span>
                      )}
                    </span>
                    <span className="shrink-0 text-right text-cg-xs">
                      <span className="block font-cg-mono">
                        <span className="text-cg-success">+{c.lines_added}</span> <span className="text-cg-sev-high">−{c.lines_removed}</span>
                      </span>
                      {!kind.quiet && (
                        <span className="block text-cg-tertiary">
                          {c.callers} caller{c.callers === 1 ? '' : 's'}
                        </span>
                      )}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        </section>
      ))}
    </div>
  );
}
