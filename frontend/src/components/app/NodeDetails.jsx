import { useMemo, useState } from 'react';
import { Code2, MousePointerClick, Search, Zap } from 'lucide-react';
import { cn } from '../../lib/cn';
import { langOf, languageName } from '../../lib/languages';
import { Button, focusRing } from '../../ui';

export const TYPE_LABEL = { file: 'File', function: 'Function', class: 'Class' };
const KIND_LABEL = { method: 'Method', interface: 'Interface', struct: 'Struct', module: 'Module' };
export const TYPE_DOT = {
  file: 'bg-cg-node-file',
  function: 'bg-cg-node-function',
  class: 'bg-cg-node-class',
  entry: 'bg-cg-node-entry',
};
export const typeKey = (node) => (node.is_entry_point && node.type !== 'file' ? 'entry' : node.type);

const LIST_LIMIT = 8;

function NodeList({ title, nodes, emptyText, onSelect, inferred = new Set() }) {
  const [showAll, setShowAll] = useState(false);
  const visible = showAll ? nodes : nodes.slice(0, LIST_LIMIT);
  return (
    <section>
      <h3 className="text-cg-xs font-medium text-cg-secondary">
        {title} <span className="tabular-nums text-cg-tertiary">({nodes.length})</span>
      </h3>
      {nodes.length === 0 ? (
        <p className="mt-2 text-cg-sm text-cg-tertiary">{emptyText}</p>
      ) : (
        <ul className="-mx-2 mt-1">
          {visible.map((n) => (
            <li key={n.id}>
              <button
                type="button"
                onClick={() => onSelect(n)}
                title={n.id}
                className={cn(
                  'flex h-7 w-full items-center gap-2 rounded-cg-control px-2 text-left text-cg-sm',
                  'text-cg-text transition-colors duration-cg-fast ease-cg hover:bg-cg-hover [@media(pointer:coarse)]:min-h-11',
                  focusRing,
                )}
              >
                <span aria-hidden="true" className={cn('h-1.5 w-1.5 shrink-0 rounded-full', TYPE_DOT[typeKey(n)])} />
                <span className="min-w-0 flex-1 truncate">{n.label}</span>
                {inferred.has(n.id) && (
                  <span className="shrink-0 text-cg-xs text-cg-tertiary" title="Linked by name: the receiver type is unknown, and only one function in the repo has this name">
                    inferred
                  </span>
                )}
                <span className="max-w-[45%] shrink-0 truncate text-cg-xs text-cg-tertiary">{n.file?.split('/').pop()}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {nodes.length > LIST_LIMIT && (
        <button
          type="button"
          onClick={() => setShowAll((v) => !v)}
          className={cn('mt-1 rounded text-cg-xs text-cg-secondary underline-offset-4 hover:text-cg-text hover:underline', focusRing)}
        >
          {showAll ? 'Show fewer' : `Show all ${nodes.length}`}
        </button>
      )}
    </section>
  );
}

/**
 * Details tab: empty state, or the selected node's summary, location and call lists.
 */
export default function NodeDetails({ node, graph, onSelectNode, onViewSource, onSimulate, onOpenSearch }) {
  const byId = useMemo(() => new Map((graph?.nodes ?? []).map((n) => [n.id, n])), [graph]);

  const { callers, callees, inferredCallers, inferredCallees } = useMemo(() => {
    const inferredCallersOut = new Set();
    const inferredCalleesOut = new Set();
    if (!node) return { callers: [], callees: [], inferredCallers: inferredCallersOut, inferredCallees: inferredCalleesOut };
    const callersOut = [];
    const calleesOut = [];
    for (const e of graph?.edges ?? []) {
      if (e.type !== 'calls') continue;
      const s = typeof e.source === 'object' ? e.source.id : e.source;
      const t = typeof e.target === 'object' ? e.target.id : e.target;
      const inferred = e.confidence === 'inferred';
      if (t === node.id && byId.has(s)) {
        callersOut.push(byId.get(s));
        if (inferred) inferredCallersOut.add(s);
      }
      if (s === node.id && byId.has(t)) {
        calleesOut.push(byId.get(t));
        if (inferred) inferredCalleesOut.add(t);
      }
    }
    return { callers: callersOut, callees: calleesOut, inferredCallers: inferredCallersOut, inferredCallees: inferredCalleesOut };
  }, [node, graph, byId]);

  if (!node) {
    return (
      <div className="flex h-full flex-col items-center justify-center px-6 py-10 text-center">
        <MousePointerClick size={24} strokeWidth={1.5} aria-hidden="true" className="text-cg-tertiary" />
        <h2 className="mt-3 text-cg-base font-medium text-cg-text">Select a node</h2>
        <p className="mt-1 max-w-[260px] text-cg-sm text-cg-secondary">See what it does, who calls it, and what it calls.</p>
        <Button
          size="sm"
          className="mt-4"
          onClick={onOpenSearch}
          leadingIcon={<Search size={16} strokeWidth={1.5} aria-hidden="true" />}
        >
          Search
        </Button>
      </div>
    );
  }

  const isFile = node.type === 'file';
  const line = node.lines?.[0];
  const location = isFile ? node.id : `${node.file}${line ? `:${line}` : ''}`;

  return (
    <div className="flex flex-col gap-6 p-4">
      <header>
        <h2 className="break-words text-cg-lg font-semibold text-cg-text">{node.label}</h2>
        <p className="mt-1 flex items-center gap-1.5 text-cg-xs text-cg-secondary">
          <span aria-hidden="true" className={cn('h-2 w-2 rounded-full', TYPE_DOT[typeKey(node)])} />
          {KIND_LABEL[node.kind] ?? TYPE_LABEL[node.type] ?? node.type}
          {langOf(node) && <span className="text-cg-tertiary">· {languageName(langOf(node))}</span>}
          {node.is_entry_point && <span className="text-cg-tertiary">· entry point</span>}
        </p>
        <button
          type="button"
          onClick={() => onViewSource(node)}
          title="Open in code view"
          className={cn(
            'mt-2 max-w-full truncate rounded text-left font-cg-mono text-cg-xs text-cg-secondary underline decoration-cg-border-strong underline-offset-4',
            'hover:text-cg-text hover:decoration-cg-text',
            focusRing,
          )}
        >
          {location}
        </button>
      </header>

      {!isFile && (
        <section>
          <h3 className="text-cg-xs font-medium text-cg-secondary">What it does</h3>
          {node.summary ? (
            <p className="mt-2 rounded-cg-control border border-cg-border bg-cg-canvas p-3 text-cg-sm text-cg-text">{node.summary}</p>
          ) : (
            <p className="mt-2 text-cg-sm text-cg-tertiary">
              {node.summary_status === 'skipped'
                ? 'Summary not generated (only the 60 most-connected functions are summarized).'
                : node.summary_status === 'failed'
                  ? 'Summary unavailable — AI provider busy.'
                  : 'No summary available.'}
            </p>
          )}
        </section>
      )}

      <div className="flex flex-wrap gap-2">
        <Button size="sm" variant="secondary" onClick={() => onViewSource(node)} leadingIcon={<Code2 size={16} strokeWidth={1.5} aria-hidden="true" />}>
          View source
        </Button>
        <Button size="sm" variant="ghost" onClick={() => onSimulate(node)} leadingIcon={<Zap size={16} strokeWidth={1.5} aria-hidden="true" />}>
          Simulate impact
        </Button>
      </div>

      {!isFile && (
        <>
          <NodeList title="Callers" nodes={callers} inferred={inferredCallers} emptyText="Nothing in this repo calls it." onSelect={onSelectNode} />
          <NodeList title="Callees" nodes={callees} inferred={inferredCallees} emptyText="It doesn't call other functions in this repo." onSelect={onSelectNode} />
        </>
      )}

      {node.type === 'function' && node.parameters?.length > 0 && (
        <section>
          <h3 className="text-cg-xs font-medium text-cg-secondary">Parameters</h3>
          <p className="mt-2 break-words font-cg-mono text-cg-xs text-cg-text">{node.parameters.join(', ')}</p>
        </section>
      )}
      {node.type === 'class' && node.base_classes?.length > 0 && (
        <section>
          <h3 className="text-cg-xs font-medium text-cg-secondary">Inherits from</h3>
          <p className="mt-2 break-words font-cg-mono text-cg-xs text-cg-text">{node.base_classes.join(', ')}</p>
        </section>
      )}
      {node.docstring?.trim() && (
        <section>
          <h3 className="text-cg-xs font-medium text-cg-secondary">Docstring</h3>
          <pre className="mt-2 max-h-40 overflow-y-auto whitespace-pre-wrap rounded-cg-control border border-cg-border bg-cg-canvas p-3 font-cg-mono text-cg-xs text-cg-secondary">
            {node.docstring}
          </pre>
        </section>
      )}
      <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-cg-xs">
        <dt className="text-cg-tertiary">Centrality</dt>
        <dd className="text-right tabular-nums text-cg-text">{((node.centrality || 0) * 100).toFixed(1)}%</dd>
        {line && (
          <>
            <dt className="text-cg-tertiary">Lines</dt>
            <dd className="text-right tabular-nums text-cg-text">
              {node.lines[0]}–{node.lines[1] ?? node.lines[0]}
            </dd>
          </>
        )}
      </dl>
    </div>
  );
}
