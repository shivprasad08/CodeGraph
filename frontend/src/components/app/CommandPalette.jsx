import { useMemo, useState } from 'react';
import { Command } from 'cmdk';
import { Search } from 'lucide-react';
import { cn } from '../../lib/cn';
import { Dialog, DialogContent, Kbd } from '../../ui';
import { TYPE_DOT, typeKey } from './NodeDetails';

const GROUPS = [
  ['file', 'Files'],
  ['function', 'Functions'],
  ['class', 'Classes'],
];

function Item({ node, value, onSelect }) {
  const path = node.type === 'file' ? node.id : node.file;
  return (
    <Command.Item
      value={value}
      keywords={[node.label, path].filter(Boolean)}
      onSelect={() => onSelect(node)}
      className={cn(
        'flex h-9 cursor-default select-none items-center gap-2 rounded-[6px] px-2 text-cg-sm text-cg-text',
        'data-[selected=true]:bg-cg-hover [@media(pointer:coarse)]:min-h-11',
      )}
    >
      <span aria-hidden="true" className={cn('h-1.5 w-1.5 shrink-0 rounded-full', TYPE_DOT[typeKey(node)])} />
      <span className="min-w-0 shrink truncate">{node.type === 'file' ? path.split('/').pop() : node.label}</span>
      <span className="ml-auto min-w-0 max-w-[55%] truncate font-cg-mono text-cg-xs text-cg-tertiary">{path}</span>
    </Command.Item>
  );
}

/**
 * Substring ranking instead of cmdk's fuzzy default (which matches scattered
 * letters across hundreds of nodes): name prefix > name contains > path contains.
 * keywords = [label, path].
 */
export function rankNode(value, search, keywords = []) {
  const q = search.trim().toLowerCase();
  if (!q) return 1;
  const [label = '', path = ''] = keywords.map((k) => k.toLowerCase());
  if (label.startsWith(q)) return 1;
  if (label.includes(q)) return 0.8;
  if (path.includes(q)) return 0.5;
  return 0;
}

const groupHeading =
  '[&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:pb-1 [&_[cmdk-group-heading]]:pt-2 [&_[cmdk-group-heading]]:text-cg-xs [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group-heading]]:text-cg-tertiary';

/**
 * ⌘K palette. Search files, functions and classes by name or path; Enter selects.
 * @param {string[]} props.recentIds Most recent first; shown when the query is empty.
 */
export default function CommandPalette({ open, onOpenChange, graph, recentIds = [], onSelect }) {
  const [query, setQuery] = useState('');
  const nodes = graph?.nodes ?? [];
  const byType = useMemo(() => {
    const groups = { file: [], function: [], class: [] };
    for (const n of nodes) groups[n.type]?.push(n);
    return groups;
  }, [nodes]);
  const recents = useMemo(() => {
    const byId = new Map(nodes.map((n) => [n.id, n]));
    return recentIds.map((id) => byId.get(id)).filter(Boolean).slice(0, 5);
  }, [nodes, recentIds]);

  const choose = (node) => {
    onOpenChange(false);
    setQuery('');
    onSelect(node);
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        onOpenChange(next);
        if (!next) setQuery('');
      }}
    >
      <DialogContent
        bare
        title="Search files and functions"
        className="top-[12vh] max-w-[560px] translate-y-0 overflow-hidden p-0 animate-cg-fade-in"
      >
        <Command label="Search files and functions" loop filter={rankNode} className="flex min-h-0 flex-col">
          <div className="flex h-12 items-center gap-2 border-b border-cg-border px-3">
            <Search size={16} strokeWidth={1.5} aria-hidden="true" className="shrink-0 text-cg-tertiary" />
            <Command.Input
              value={query}
              onValueChange={setQuery}
              placeholder="Search files and functions…"
              className="h-full min-w-0 flex-1 bg-transparent text-cg-base text-cg-text outline-none placeholder:text-cg-tertiary [@media(pointer:coarse)]:text-[16px]"
            />
            <Kbd>Esc</Kbd>
          </div>
          <Command.List className={cn('max-h-[min(420px,60dvh)] overflow-y-auto p-1', groupHeading)}>
            <Command.Empty className="px-3 py-6 text-center text-cg-sm text-cg-tertiary">No files or functions match “{query}”.</Command.Empty>
            {!query && recents.length > 0 && (
              <Command.Group heading="Recent">
                {recents.map((n) => (
                  <Item key={`recent-${n.id}`} node={n} value={`recent:${n.id}`} onSelect={choose} />
                ))}
              </Command.Group>
            )}
            {GROUPS.map(([type, heading]) =>
              byType[type].length ? (
                <Command.Group key={type} heading={heading}>
                  {byType[type].map((n) => (
                    <Item key={n.id} node={n} value={n.id} onSelect={choose} />
                  ))}
                </Command.Group>
              ) : null,
            )}
          </Command.List>
        </Command>
      </DialogContent>
    </Dialog>
  );
}
