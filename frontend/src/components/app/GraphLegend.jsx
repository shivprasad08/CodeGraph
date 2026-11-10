import { useEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown, ChevronUp } from 'lucide-react';
import { cn } from '../../lib/cn';
import { clusterToken, moduleColoring } from '../../lib/moduleColors';
import { focusRing } from '../../ui';

/** Node type shapes, drawn exactly as the canvas draws them (neutral colour here). */
export function TypeShape({ type }) {
  const common = { width: 12, height: 12, viewBox: '0 0 12 12', 'aria-hidden': true, className: 'shrink-0 text-cg-secondary' };
  if (type === 'file') return <svg {...common}><rect x="2.5" y="2.5" width="7" height="7" rx="2" fill="currentColor" /></svg>;
  if (type === 'class') return <svg {...common}><circle cx="6" cy="6" r="3.6" fill="none" stroke="currentColor" strokeWidth="1.4" /></svg>;
  if (type === 'entry') {
    return (
      <svg {...common}>
        <circle cx="6" cy="6" r="3" fill="currentColor" />
        <circle cx="6" cy="6" r="5.2" fill="none" stroke="currentColor" strokeWidth="1" />
      </svg>
    );
  }
  return <svg {...common}><circle cx="6" cy="6" r="3.2" fill="currentColor" /></svg>;
}

const TYPES = [
  ['file', 'File'],
  ['class', 'Class'],
  ['function', 'Function'],
  ['entry', 'Entry point'],
];

/**
 * Collapsed "Legend" chip at the canvas bottom-left; opens a popover: node types by shape,
 * modules by colour (same colours as the architecture view), and a "Show modules" toggle.
 */
export default function GraphLegend({ graph, hullsVisible, onHullsVisibleChange }) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef(null);
  const buttonRef = useRef(null);
  const modules = useMemo(() => {
    const coloring = moduleColoring(graph);
    return [...coloring.modules]
      .sort((a, b) => (b.files?.length ?? 0) - (a.files?.length ?? 0) || a.label.localeCompare(b.label))
      .map((m) => ({ id: m.id, label: m.label, files: m.files?.length ?? 0, color: clusterToken(coloring.colorIndex.get(m.id)) }));
  }, [graph]);

  useEffect(() => {
    if (!open) return undefined;
    const onPointer = (e) => !rootRef.current?.contains(e.target) && setOpen(false);
    document.addEventListener('mousedown', onPointer);
    return () => document.removeEventListener('mousedown', onPointer);
  }, [open]);

  return (
    <div
      ref={rootRef}
      className="absolute bottom-3 left-3 z-10 font-cg-sans"
      onKeyDown={(e) => {
        if (e.key === 'Escape' && open) {
          e.stopPropagation();
          setOpen(false);
          buttonRef.current?.focus();
        }
      }}
    >
      {open && (
        <div
          id="graph-legend"
          role="region"
          aria-label="Legend"
          className="absolute bottom-full left-0 mb-2 w-64 rounded-cg-panel border border-cg-border bg-cg-overlay p-3 shadow-cg-edge animate-cg-fade-in"
        >
          <h3 className="text-cg-xs font-medium text-cg-secondary">Node types</h3>
          <ul className="mt-2 grid grid-cols-2 gap-1.5 text-cg-xs text-cg-text">
            {TYPES.map(([key, label]) => (
              <li key={key} className="flex items-center gap-2">
                <TypeShape type={key} />
                {label}
              </li>
            ))}
          </ul>
          <p className="mt-2 text-cg-xs text-cg-tertiary">Size shows how connected a node is. Dashed links are inferred by name.</p>
          {modules.length > 0 && (
            <>
              <div className="mt-3 flex items-center justify-between border-t border-cg-border pt-3">
                <h3 className="text-cg-xs font-medium text-cg-secondary">Modules</h3>
                <label className="flex items-center gap-1.5 text-cg-xs text-cg-secondary [@media(pointer:coarse)]:min-h-11">
                  <input
                    type="checkbox"
                    checked={hullsVisible}
                    onChange={(e) => onHullsVisibleChange(e.target.checked)}
                    className="h-3.5 w-3.5 accent-[var(--cg-text)]"
                  />
                  Show modules
                </label>
              </div>
              <ul className="mt-2 flex max-h-48 flex-col gap-1 overflow-y-auto">
                {modules.map((m) => (
                  <li key={m.id} className="flex h-6 items-center gap-2 px-1 text-cg-xs">
                    <span aria-hidden="true" className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: m.color }} />
                    <span className="min-w-0 flex-1 truncate text-cg-text">{m.label}</span>
                    <span className="shrink-0 tabular-nums text-cg-tertiary">
                      {m.files} {m.files === 1 ? 'file' : 'files'}
                    </span>
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
      )}
      <button
        ref={buttonRef}
        type="button"
        aria-expanded={open}
        aria-controls="graph-legend"
        onClick={() => setOpen((v) => !v)}
        className={cn(
          'inline-flex h-7 items-center gap-1.5 rounded-cg-control border border-cg-border bg-cg-overlay px-2.5 text-cg-xs text-cg-secondary shadow-cg-edge',
          'transition-colors duration-cg-fast ease-cg hover:text-cg-text [@media(pointer:coarse)]:min-h-11',
          focusRing,
        )}
      >
        Legend
        {open ? <ChevronDown size={14} strokeWidth={1.5} aria-hidden="true" /> : <ChevronUp size={14} strokeWidth={1.5} aria-hidden="true" />}
      </button>
    </div>
  );
}
