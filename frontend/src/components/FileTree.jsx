import { langOf, languageName, languageTag } from '../lib/languages';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ChevronsDownUp, File, Folder, FolderOpen, Search, X, Zap, Crosshair } from 'lucide-react';
import { cn } from '../lib/cn';
import { getTopLevelDir } from '../utils/directoryColors';
import { IconButton, Input } from '../ui';

const TYPE_DOT = { function: 'bg-cg-node-function', class: 'bg-cg-node-class' };

// ---------------------------------------------------------------------------
// Tree model
// ---------------------------------------------------------------------------
function buildTree(nodes) {
  const root = { dirs: new Map(), files: [] };
  for (const node of nodes) {
    if (node.type !== 'file') continue;
    const parts = (node.path ?? node.id).split('/');
    let dir = root;
    let dirPath = '';
    for (const part of parts.slice(0, -1)) {
      dirPath = dirPath ? `${dirPath}/${part}` : part;
      if (!dir.dirs.has(part)) dir.dirs.set(part, { path: dirPath, dirs: new Map(), files: [] });
      dir = dir.dirs.get(part);
    }
    dir.files.push({ name: parts.at(-1), node });
  }
  return root;
}

function initialExpanded(tree) {
  // Same default as before: the first two levels are open
  const open = new Set();
  const walk = (dir, depth) => {
    for (const child of dir.dirs.values()) {
      if (depth < 2) open.add(child.path);
      walk(child, depth + 1);
    }
  };
  walk(tree, 0);
  return open;
}

/** Visible rows in display order, with parent links for keyboard navigation. */
function flattenRows({ tree, expanded, filter, selectedFilePath, symbolsByFile }) {
  const rows = [];
  const q = filter.trim().toLowerCase();
  const matchesFile = (f) => !q || f.node.id.toLowerCase().includes(q);
  const dirHasMatch = (dir) => dir.files.some(matchesFile) || [...dir.dirs.values()].some(dirHasMatch);

  const walk = (dir, depth, parentId) => {
    const dirs = [...dir.dirs.entries()].sort(([a], [b]) => a.localeCompare(b));
    for (const [name, child] of dirs) {
      if (q && !dirHasMatch(child)) continue;
      const id = `dir:${child.path}`;
      const open = q ? true : expanded.has(child.path);
      rows.push({ id, kind: 'dir', name, path: child.path, depth, parentId, expanded: open });
      if (open) walk(child, depth + 1, id);
    }
    const files = [...dir.files].sort((a, b) => a.name.localeCompare(b.name)).filter(matchesFile);
    for (const f of files) {
      const id = `file:${f.node.id}`;
      const isSelected = f.node.id === selectedFilePath;
      const symbols = isSelected ? symbolsByFile.get(f.node.id) ?? [] : [];
      rows.push({
        id,
        kind: 'file',
        name: f.name,
        path: f.node.id,
        node: f.node,
        depth,
        parentId,
        expanded: symbols.length ? true : undefined,
      });
      for (const sym of symbols) {
        rows.push({ id: `sym:${sym.id}`, kind: 'symbol', name: sym.label || sym.id.split('::').pop(), node: sym, depth: depth + 1, parentId: id });
      }
    }
  };
  walk(tree, 0, null);
  return rows;
}

// ---------------------------------------------------------------------------
// FileTree
// ---------------------------------------------------------------------------
/**
 * File tree (role="tree"). Arrow keys move and expand/collapse, Enter selects,
 * Home/End jump; Shift+F10 or right-click opens the file menu.
 */
export default function FileTree({
  graph,
  onFileSelect,
  onNodeSelect,
  onSimulateFile,
  selectedFilePath,
  selectedNodeId,
  dirColorMap = {},
  fileColor, // path → CSS colour of its architecture module (falls back to dirColorMap)
}) {
  const nodes = graph?.nodes ?? [];
  const tree = useMemo(() => buildTree(nodes), [nodes]);
  const symbolsByFile = useMemo(() => {
    const m = new Map();
    for (const n of nodes) {
      if (n.type !== 'function' && n.type !== 'class') continue;
      if (!m.has(n.file)) m.set(n.file, []);
      m.get(n.file).push(n);
    }
    for (const list of m.values()) list.sort((a, b) => (a.lines?.[0] || 0) - (b.lines?.[0] || 0));
    return m;
  }, [nodes]);

  const [expanded, setExpanded] = useState(() => initialExpanded(tree));
  const [filterOpen, setFilterOpen] = useState(false);
  const [filter, setFilter] = useState('');
  const [activeId, setActiveId] = useState(null);
  const [menu, setMenu] = useState(null); // { x, y, path }
  const treeRef = useRef(null);
  const filterRef = useRef(null);

  useEffect(() => setExpanded(initialExpanded(tree)), [tree]);

  const rows = useMemo(
    () => flattenRows({ tree, expanded, filter, selectedFilePath, symbolsByFile }),
    [tree, expanded, filter, selectedFilePath, symbolsByFile],
  );

  // Keep the roving focus target valid and in sync with the selection
  useEffect(() => {
    const selectedRow =
      (selectedNodeId && rows.find((r) => r.kind === 'symbol' && r.node.id === selectedNodeId)) ||
      (selectedFilePath && rows.find((r) => r.kind === 'file' && r.path === selectedFilePath));
    if (selectedRow) setActiveId(selectedRow.id);
    else if (!rows.some((r) => r.id === activeId)) setActiveId(rows[0]?.id ?? null);
  }, [rows, selectedNodeId, selectedFilePath]); // eslint-disable-line react-hooks/exhaustive-deps

  const focusRow = useCallback((id) => {
    setActiveId(id);
    requestAnimationFrame(() => {
      // Match on the dataset rather than a selector: ids contain paths and "::"
      const rowsEls = treeRef.current?.querySelectorAll('[data-row-id]') ?? [];
      [...rowsEls].find((el) => el.dataset.rowId === id)?.focus();
    });
  }, []);

  const toggleDir = (path, open) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      const shouldOpen = open ?? !next.has(path);
      if (shouldOpen) next.add(path);
      else next.delete(path);
      return next;
    });

  const activate = (row) => {
    if (row.kind === 'dir') toggleDir(row.path);
    else if (row.kind === 'file') onFileSelect(row.path);
    else onNodeSelect(row.node);
  };

  const openMenu = (row, x, y) => {
    if (row.kind !== 'file') return;
    setMenu({ x, y, path: row.path, rowId: row.id });
  };

  const handleKeyDown = (e) => {
    const index = rows.findIndex((r) => r.id === activeId);
    const row = rows[index];
    if (!row) return;
    const move = (i) => {
      e.preventDefault();
      const target = rows[Math.max(0, Math.min(rows.length - 1, i))];
      if (target) focusRow(target.id);
    };
    switch (e.key) {
      case 'ArrowDown':
        return move(index + 1);
      case 'ArrowUp':
        return move(index - 1);
      case 'Home':
        return move(0);
      case 'End':
        return move(rows.length - 1);
      case 'ArrowRight':
        e.preventDefault();
        if (row.kind === 'dir' && !row.expanded) toggleDir(row.path, true);
        else if (row.expanded && rows[index + 1]?.parentId === row.id) focusRow(rows[index + 1].id);
        else if (row.kind === 'file' && !row.expanded) onFileSelect(row.path);
        return undefined;
      case 'ArrowLeft':
        e.preventDefault();
        if (row.kind === 'dir' && row.expanded && !filter) toggleDir(row.path, false);
        else if (row.parentId) focusRow(row.parentId);
        return undefined;
      case 'Enter':
      case ' ':
        e.preventDefault();
        activate(row);
        return undefined;
      case 'ContextMenu':
      case 'F10':
        if (e.key === 'F10' && !e.shiftKey) return undefined;
        e.preventDefault();
        {
          const rect = e.target.getBoundingClientRect();
          openMenu(row, rect.left + 24, rect.bottom);
        }
        return undefined;
      default:
        return undefined;
    }
  };

  const toggleFilter = () => {
    if (filterOpen) {
      setFilter('');
      setFilterOpen(false);
    } else {
      setFilterOpen(true);
      requestAnimationFrame(() => filterRef.current?.focus());
    }
  };

  return (
    <div className="relative flex h-full min-h-0 flex-col overflow-hidden bg-cg-raised font-cg-sans">
      <div className="flex h-10 shrink-0 items-center justify-between gap-2 border-b border-cg-border pl-3 pr-1.5">
        <h2 className="text-cg-sm font-medium text-cg-text">Files</h2>
        <div className="flex items-center">
          <IconButton label={filterOpen ? 'Close filter' : 'Filter files'} size="sm" onClick={toggleFilter} aria-pressed={filterOpen}>
            {filterOpen ? <X size={16} strokeWidth={1.5} aria-hidden="true" /> : <Search size={16} strokeWidth={1.5} aria-hidden="true" />}
          </IconButton>
          <IconButton label="Collapse all" size="sm" onClick={() => setExpanded(new Set())}>
            <ChevronsDownUp size={16} strokeWidth={1.5} aria-hidden="true" />
          </IconButton>
        </div>
      </div>

      {filterOpen && (
        <div className="shrink-0 border-b border-cg-border p-2">
          <Input
            ref={filterRef}
            label="Filter files"
            hideLabel
            placeholder="Filter files"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                e.stopPropagation();
                toggleFilter();
              } else if (e.key === 'ArrowDown' && rows[0]) {
                e.preventDefault();
                focusRow(rows[0].id);
              }
            }}
            autoComplete="off"
            spellCheck={false}
          />
        </div>
      )}

      <div className="relative min-h-0 flex-1 overflow-y-auto py-1">
        {rows.length === 0 ? (
          <p className="px-3 py-6 text-cg-sm text-cg-tertiary">
            {filter ? `No files match “${filter}”.` : 'No files in this analysis.'}
          </p>
        ) : (
          <div ref={treeRef} role="tree" aria-label="Files" onKeyDown={handleKeyDown}>
            {rows.map((row) => {
              const isSelected =
                (row.kind === 'symbol' && row.node.id === selectedNodeId) ||
                (row.kind === 'file' && row.path === selectedFilePath && !rows.some((r) => r.kind === 'symbol' && r.node.id === selectedNodeId));
              const clusterColor = row.kind === 'file' ? (fileColor ? fileColor(row.path) : dirColorMap[getTopLevelDir(row.path)]?.stroke) : null;
              const Icon = row.kind === 'dir' ? (row.expanded ? FolderOpen : Folder) : File;
              return (
                <div
                  key={row.id}
                  role="treeitem"
                  data-row-id={row.id}
                  aria-level={row.depth + 1}
                  aria-expanded={row.expanded}
                  aria-selected={isSelected}
                  tabIndex={row.id === activeId ? 0 : -1}
                  title={row.kind === 'symbol' ? row.node.id : row.path}
                  onClick={() => {
                    setActiveId(row.id);
                    activate(row);
                  }}
                  onContextMenu={(e) => {
                    if (row.kind !== 'file') return;
                    e.preventDefault();
                    setActiveId(row.id);
                    openMenu(row, e.clientX, e.clientY);
                  }}
                  onFocus={() => setActiveId(row.id)}
                  style={{ paddingLeft: 8 + row.depth * 8 }}
                  className={cn(
                    'relative flex h-7 cursor-default select-none items-center gap-1.5 pr-2 text-cg-sm outline-none',
                    'transition-colors duration-cg-fast ease-cg [@media(pointer:coarse)]:min-h-11',
                    'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-cg-focus',
                    isSelected
                      ? 'bg-cg-overlay text-cg-text before:absolute before:inset-y-0 before:left-0 before:w-0.5 before:bg-cg-text'
                      : 'text-cg-secondary hover:bg-cg-hover hover:text-cg-text',
                  )}
                >
                  {row.kind === 'symbol' ? (
                    <span aria-hidden="true" className={cn('ml-[5px] mr-[3px] h-1.5 w-1.5 shrink-0 rounded-full', TYPE_DOT[row.node.type])} />
                  ) : (
                    <Icon size={16} strokeWidth={1.5} aria-hidden="true" className="shrink-0 text-cg-tertiary" />
                  )}
                  <span className="min-w-0 truncate">{row.name}</span>
                  {clusterColor && (
                    <span aria-hidden="true" className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: clusterColor }} />
                  )}
                  {row.kind === 'file' && langOf(row.node) && (
                    // Visual only (pseudo-element): the extension already names the language, so the
                    // tree item's accessible name stays the file name
                    <span
                      aria-hidden="true"
                      data-tag={languageTag(langOf(row.node))}
                      title={languageName(langOf(row.node))}
                      className="ml-auto shrink-0 text-cg-xs text-cg-tertiary after:content-[attr(data-tag)]"
                    />
                  )}
                  {row.kind === 'symbol' && row.node.lines?.[0] && (
                    <span className="ml-auto shrink-0 text-cg-xs tabular-nums text-cg-tertiary">{row.node.lines[0]}</span>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {menu && (
        <FileMenu
          {...menu}
          onClose={(restore) => {
            setMenu(null);
            if (restore) focusRow(menu.rowId);
          }}
          onShow={() => onFileSelect(menu.path)}
          onSimulate={() => onSimulateFile?.(menu.path)}
        />
      )}
    </div>
  );
}

/** Small context menu for a file row (role="menu", arrow keys, Esc). */
function FileMenu({ x, y, onClose, onShow, onSimulate }) {
  const ref = useRef(null);
  useEffect(() => {
    ref.current?.querySelector('[role="menuitem"]')?.focus();
    const onPointer = (e) => !ref.current?.contains(e.target) && onClose(false);
    document.addEventListener('mousedown', onPointer);
    return () => document.removeEventListener('mousedown', onPointer);
  }, [onClose]);

  const items = [
    ['Show in graph', <Crosshair key="i" size={16} strokeWidth={1.5} aria-hidden="true" />, onShow],
    ['Simulate impact', <Zap key="i" size={16} strokeWidth={1.5} aria-hidden="true" />, onSimulate],
  ];
  return (
    <div
      ref={ref}
      role="menu"
      aria-label="File actions"
      style={{ top: Math.min(y, window.innerHeight - 96), left: Math.min(x, window.innerWidth - 200) }}
      className="fixed z-[70] min-w-44 rounded-cg-control border border-cg-border bg-cg-overlay p-1 font-cg-sans shadow-cg-edge"
      onKeyDown={(e) => {
        const els = [...ref.current.querySelectorAll('[role="menuitem"]')];
        const i = els.indexOf(document.activeElement);
        if (e.key === 'Escape' || e.key === 'Tab') {
          e.preventDefault();
          e.stopPropagation();
          onClose(true);
        } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
          e.preventDefault();
          els[(i + (e.key === 'ArrowDown' ? 1 : -1) + els.length) % els.length]?.focus();
        }
      }}
    >
      {items.map(([label, icon, action]) => (
        <button
          key={label}
          type="button"
          role="menuitem"
          tabIndex={-1}
          onClick={() => {
            action();
            onClose(false);
          }}
          className="flex h-8 w-full items-center gap-2 rounded-[6px] px-2 text-left text-cg-sm text-cg-text outline-none hover:bg-cg-hover focus:bg-cg-hover [@media(pointer:coarse)]:min-h-11"
        >
          <span className="text-cg-secondary">{icon}</span>
          {label}
        </button>
      ))}
    </div>
  );
}
