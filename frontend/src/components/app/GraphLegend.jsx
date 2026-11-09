import { useEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown, ChevronUp } from 'lucide-react';
import { cn } from '../../lib/cn';
import { groupNodesByDirectory } from '../../utils/directoryColors';
import { focusRing } from '../../ui';
import { NODE_COLORS } from '../GraphCanvas';

const TYPES = [
  ['file', 'File'],
  ['function', 'Function'],
  ['class', 'Class'],
  ['entry', 'Entry point'],
];

/**
 * Collapsed "Legend" chip at the canvas bottom-left; opens a popover with node
 * types and directory clusters (toggle hulls, hide/show a cluster).
 */
export default function GraphLegend({ graph, dirColorMap, hullsVisible, onHullsVisibleChange, hiddenDirs, onHiddenDirsChange }) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef(null);
  const buttonRef = useRef(null);
  const dirCounts = useMemo(() => groupNodesByDirectory(graph?.nodes ?? []), [graph]);
  const dirs = Object.keys(dirColorMap).sort();

  useEffect(() => {
    if (!open) return undefined;
    const onPointer = (e) => !rootRef.current?.contains(e.target) && setOpen(false);
    document.addEventListener('mousedown', onPointer);
    return () => document.removeEventListener('mousedown', onPointer);
  }, [open]);

  const toggleDir = (dir) => {
    const next = new Set(hiddenDirs);
    if (next.has(dir)) next.delete(dir);
    else next.add(dir);
    onHiddenDirsChange(next);
  };

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
                <span aria-hidden="true" className="h-2 w-2 rounded-full" style={{ backgroundColor: NODE_COLORS[key] }} />
                {label}
              </li>
            ))}
          </ul>
          {dirs.length > 0 && (
            <>
              <div className="mt-3 flex items-center justify-between border-t border-cg-border pt-3">
                <h3 className="text-cg-xs font-medium text-cg-secondary">Directory clusters</h3>
                <label className="flex items-center gap-1.5 text-cg-xs text-cg-secondary">
                  <input
                    type="checkbox"
                    checked={hullsVisible}
                    onChange={(e) => onHullsVisibleChange(e.target.checked)}
                    className="h-3.5 w-3.5 accent-[var(--cg-text)]"
                  />
                  Show
                </label>
              </div>
              <ul className="mt-2 flex max-h-48 flex-col overflow-y-auto">
                {dirs.map((dir) => {
                  const hidden = hiddenDirs.has(dir);
                  return (
                    <li key={dir}>
                      <button
                        type="button"
                        aria-pressed={!hidden}
                        onClick={() => toggleDir(dir)}
                        title={hidden ? 'Show this cluster' : 'Hide this cluster'}
                        className={cn('flex h-7 w-full items-center gap-2 rounded px-1 text-left text-cg-xs hover:bg-cg-hover [@media(pointer:coarse)]:min-h-11', focusRing)}
                      >
                        <span aria-hidden="true" className="h-2 w-2 shrink-0 rounded-sm" style={{ backgroundColor: dirColorMap[dir].stroke }} />
                        <span className={cn('min-w-0 flex-1 truncate', hidden ? 'text-cg-tertiary line-through' : 'text-cg-text')}>
                          {dir === '__root__' ? 'Root files' : `${dir}/`}
                        </span>
                        <span className="shrink-0 tabular-nums text-cg-tertiary">{dirCounts[dir]?.length || 0}</span>
                      </button>
                    </li>
                  );
                })}
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
