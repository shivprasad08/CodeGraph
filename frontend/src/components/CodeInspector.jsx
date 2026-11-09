import { useState, useEffect, useRef, useMemo } from 'react';
import hljs from 'highlight.js/lib/core';
import python from 'highlight.js/lib/languages/python';
import { ExternalLink, FileCode2, X } from 'lucide-react';
import { API_ERROR, fetchFileSource } from '../api';
import { cn } from '../lib/cn';
import { IconButton } from '../ui';
import { InlineError } from './app/RecoveryStatus';

hljs.registerLanguage('python', python);

const LINE_HEIGHT = 21;
// Minimap marks use the data palette (definitions, classes, imports)
const MINIMAP = {
  selected: 'rgba(237, 237, 239, 0.85)',
  classDef: 'rgba(229, 165, 75, 0.7)',
  defLine: 'rgba(157, 140, 242, 0.7)',
  import: 'rgba(91, 141, 239, 0.45)',
  text: 'rgba(237, 237, 239, 0.12)',
};

/**
 * Code view: a resizable drawer over the bottom of the graph.
 * @param {number} [props.focusLine] Scroll to this line (e.g. from a health issue).
 */
export default function CodeInspector({
  filePath,
  graph,
  selectedNodeId,
  onClose,
  onNodeClick,
  repo,
  commitSha,
  offline = false, // static demo: no backend, so no source fetch
  focusLine,
  onRerun,
}) {
  const [inspectorHeight, setInspectorHeight] = useState(() => Math.floor(window.innerHeight * 0.45));
  const [isResizing, setIsResizing] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState(null); // ApiError: friendly message + code
  const [recovering, setRecovering] = useState(false);
  const [sourceCode, setSourceCode] = useState('');

  const lineNumbersRef = useRef(null);
  const codeRef = useRef(null);

  // Resizing
  useEffect(() => {
    if (!isResizing) return undefined;
    const handleMove = (e) => {
      const y = e.touches ? e.touches[0].clientY : e.clientY;
      setInspectorHeight(Math.min(Math.max(window.innerHeight - y, 160), window.innerHeight * 0.8));
    };
    const stop = () => setIsResizing(false);
    document.addEventListener('mousemove', handleMove);
    document.addEventListener('mouseup', stop);
    document.addEventListener('touchmove', handleMove);
    document.addEventListener('touchend', stop);
    return () => {
      document.removeEventListener('mousemove', handleMove);
      document.removeEventListener('mouseup', stop);
      document.removeEventListener('touchmove', handleMove);
      document.removeEventListener('touchend', stop);
    };
  }, [isResizing]);

  // Fetch source
  useEffect(() => {
    if (offline || !filePath || !repo || !commitSha) return undefined;
    let isMounted = true;
    (async () => {
      setIsLoading(true);
      setError(null);
      setSourceCode('');
      try {
        const res = await fetchFileSource(repo, commitSha, filePath, {
          onRecovering: () => isMounted && setRecovering(true),
          onRecovered: () => isMounted && setRecovering(false),
        });
        if (isMounted) setSourceCode(res.content || '');
      } catch (err) {
        if (isMounted) setError(err);
      } finally {
        if (isMounted) {
          setIsLoading(false);
          setRecovering(false);
        }
      }
    })();
    return () => {
      isMounted = false;
    };
  }, [filePath, repo, commitSha, offline]);

  // Graph cross-referencing
  const fileNodes = useMemo(() => graph?.nodes.filter((n) => n.file === filePath) || [], [graph, filePath]);
  const fileEdges = useMemo(
    () =>
      graph?.edges.filter((e) => {
        const srcId = typeof e.source === 'object' ? e.source.id : e.source;
        return srcId.startsWith(filePath);
      }) || [],
    [graph, filePath],
  );

  // Selected node: whole body; other definitions: their first line
  const highlightedRanges = useMemo(() => {
    const ranges = new Set();
    for (const node of fileNodes) {
      if (!node.lines || node.lines.length < 2) continue;
      const [start, end] = node.lines;
      if (node.id === selectedNodeId) for (let l = start; l <= end; l++) ranges.add(l);
      else ranges.add(start);
    }
    return ranges;
  }, [fileNodes, selectedNodeId]);

  // Scroll to the selected node or a requested line
  useEffect(() => {
    if (!codeRef.current || !sourceCode) return;
    const node = selectedNodeId && fileNodes.find((n) => n.id === selectedNodeId);
    const target = focusLine || node?.lines?.[0];
    if (!target) return;
    const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    codeRef.current.scrollTo({ top: Math.max(0, (target - 5) * LINE_HEIGHT), behavior: reduce ? 'auto' : 'smooth' });
  }, [selectedNodeId, fileNodes, sourceCode, focusLine]);

  const renderedLines = useMemo(() => {
    if (!sourceCode) return [];
    const lines = hljs.highlight(sourceCode, { language: 'python' }).value.split('\n');

    // Calls made from each definition, shown on its def line
    const callSitesByLine = {};
    for (const edge of fileEdges) {
      if (edge.type !== 'calls') continue;
      const srcId = typeof edge.source === 'object' ? edge.source.id : edge.source;
      const tgtId = typeof edge.target === 'object' ? edge.target.id : edge.target;
      const caller = fileNodes.find((n) => n.id === srcId);
      if (caller?.lines) {
        const defLine = caller.lines[0];
        (callSitesByLine[defLine] ??= new Set()).add(tgtId.split('::').pop());
      }
    }

    return lines.map((htmlStr, idx) => {
      const lineNum = idx + 1;
      let html = htmlStr;
      // Clickable function/class names
      for (const node of fileNodes) {
        if (node.type === 'file') continue;
        const label = node.label || node.id.split('::').pop();
        if (!label) continue;
        const pattern = new RegExp(`(<span class="hljs-title[^"]*">)(${label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})(</span>)`, 'g');
        html = html.replace(
          pattern,
          `$1<span class="codegraph-fn-link" data-id="${node.id}" style="cursor:pointer;text-decoration:underline dotted;text-underline-offset:3px">$2</span>$3`,
        );
      }
      return {
        lineNum,
        html,
        isImport: html.includes('<span class="hljs-keyword">import</span>') || html.includes('<span class="hljs-keyword">from</span>'),
        calls: callSitesByLine[lineNum] ? [...callSitesByLine[lineNum]] : [],
        isHighlighted: highlightedRanges.has(lineNum) || lineNum === focusLine,
        isDefLine: fileNodes.some((n) => n.lines && n.lines[0] === lineNum),
        isClassDef: fileNodes.some((n) => n.type === 'class' && n.lines && n.lines[0] === lineNum),
      };
    });
  }, [sourceCode, fileNodes, fileEdges, highlightedRanges, focusLine]);

  const syncScroll = (e) => {
    if (e.target === codeRef.current && lineNumbersRef.current) lineNumbersRef.current.scrollTop = e.target.scrollTop;
  };

  const handleCodeClick = (e) => {
    const link = e.target.closest('[data-id]');
    if (!link) return;
    const node = graph?.nodes.find((n) => n.id === link.dataset.id);
    if (node) onNodeClick?.(node);
  };

  const handleMinimapClick = (e) => {
    if (!codeRef.current || !renderedLines.length) return;
    const rect = e.currentTarget.getBoundingClientRect();
    codeRef.current.scrollTop = Math.floor(((e.clientY - rect.top) / rect.height) * renderedLines.length) * LINE_HEIGHT;
  };

  if (!filePath) return null;

  const fnCount = fileNodes.filter((n) => n.type === 'function').length;
  const classCount = fileNodes.filter((n) => n.type === 'class').length;
  const parts = filePath.split('/');

  return (
    <section
      aria-label={`Code view: ${filePath}`}
      className="absolute inset-x-0 bottom-0 z-20 flex flex-col border-t border-cg-border bg-cg-raised font-cg-sans shadow-cg-edge"
      style={{ height: inspectorHeight }}
    >
      <div
        role="separator"
        aria-orientation="horizontal"
        aria-label="Resize code view"
        tabIndex={0}
        onMouseDown={() => setIsResizing(true)}
        onTouchStart={() => setIsResizing(true)}
        onKeyDown={(e) => {
          if (e.key === 'ArrowUp') setInspectorHeight((h) => Math.min(h + 24, window.innerHeight * 0.8));
          if (e.key === 'ArrowDown') setInspectorHeight((h) => Math.max(h - 24, 160));
        }}
        className="group flex h-2 shrink-0 cursor-ns-resize items-center justify-center outline-none focus-visible:bg-cg-hover"
      >
        <span className="h-0.5 w-8 rounded-full bg-cg-border-strong group-hover:bg-cg-secondary" />
      </div>

      <header className="flex h-10 shrink-0 items-center gap-3 border-b border-cg-border px-3">
        <FileCode2 size={16} strokeWidth={1.5} aria-hidden="true" className="shrink-0 text-cg-tertiary" />
        <p className="min-w-0 flex-1 truncate font-cg-mono text-cg-xs" title={filePath}>
          {parts.slice(0, -1).map((p, i) => (
            <span key={i} className="text-cg-tertiary">
              {p}/
            </span>
          ))}
          <span className="text-cg-text">{parts.at(-1)}</span>
        </p>
        <p className="hidden shrink-0 gap-3 text-cg-xs tabular-nums text-cg-tertiary sm:flex">
          {renderedLines.length > 0 && <span>{renderedLines.length} lines</span>}
          {fnCount > 0 && <span>{fnCount} functions</span>}
          {classCount > 0 && <span>{classCount} classes</span>}
        </p>
        <IconButton
          label="Open on GitHub"
          size="sm"
          onClick={() => window.open(`https://github.com/${repo}/blob/${commitSha}/${filePath}`, '_blank', 'noopener,noreferrer')}
        >
          <ExternalLink size={16} strokeWidth={1.5} aria-hidden="true" />
        </IconButton>
        <IconButton label="Close code view" shortcut="Esc" size="sm" onClick={onClose}>
          <X size={16} strokeWidth={1.5} aria-hidden="true" />
        </IconButton>
      </header>

      {offline && (
        <div className="flex flex-1 flex-col items-center justify-center gap-1 p-6 text-center">
          <FileCode2 size={24} strokeWidth={1.5} aria-hidden="true" className="text-cg-tertiary" />
          <p className="mt-2 text-cg-sm text-cg-text">Source is available on your own analyses</p>
          <p className="text-cg-xs text-cg-secondary">The demo includes the graph, not the files.</p>
        </div>
      )}

      {!offline && isLoading && (
        <div className="flex flex-1 flex-col gap-2 overflow-hidden p-4" aria-busy="true" aria-label="Loading source">
          {recovering && (
            <p role="status" className="mb-1 text-cg-xs text-cg-tertiary">
              Reloading this analysis on the server…
            </p>
          )}
          {[72, 48, 88, 60, 30, 80, 54, 66].map((w, i) => (
            <div key={i} className="h-3 rounded bg-cg-hover" style={{ width: `${w}%` }} />
          ))}
        </div>
      )}

      {!offline && error && !isLoading && (
        <div className="flex flex-1 items-center justify-center p-6">
          <InlineError
            className="max-w-sm"
            message={`Couldn't load ${parts.at(-1)}. ${error.message ?? ''}`.trim()}
            onRerun={error.code === API_ERROR.CACHE_MISS ? onRerun : undefined}
          />
        </div>
      )}

      {!offline && !isLoading && !error && sourceCode && (
        <div className="relative flex min-h-0 flex-1 overflow-hidden">
          <div ref={lineNumbersRef} aria-hidden="true" className="w-11 shrink-0 overflow-hidden border-r border-cg-border bg-cg-raised pb-12">
            {renderedLines.map((l) => (
              <div key={l.lineNum} className="flex h-[21px] items-center justify-end pr-3 font-cg-mono text-cg-xs text-cg-tertiary">
                {l.lineNum}
              </div>
            ))}
          </div>

          <div ref={codeRef} className="relative flex-1 overflow-auto bg-cg-canvas pb-12" onScroll={syncScroll} onClick={handleCodeClick}>
            {renderedLines.map((l) => (
              <div
                key={l.lineNum}
                className={cn(
                  'group relative flex h-[21px] items-center whitespace-pre border-l-2 px-4 font-cg-mono text-cg-xs leading-[21px] hover:bg-cg-hover',
                  l.isHighlighted ? 'border-cg-text bg-cg-hover' : 'border-transparent',
                )}
              >
                <div className="flex-1 overflow-hidden text-ellipsis" dangerouslySetInnerHTML={{ __html: l.html || ' ' }} />
                {l.calls.length > 0 && (
                  <span className="pointer-events-none absolute right-4 hidden h-full items-center bg-cg-hover pl-2 text-cg-xs text-cg-secondary group-hover:flex">
                    calls {l.calls.join(', ')}
                  </span>
                )}
              </div>
            ))}
          </div>

          <div
            aria-hidden="true"
            className="relative hidden w-14 shrink-0 cursor-pointer border-l border-cg-border bg-cg-raised md:block"
            onClick={handleMinimapClick}
          >
            {renderedLines.map((l) => {
              let color = MINIMAP.text;
              if (l.isHighlighted && selectedNodeId) color = MINIMAP.selected;
              else if (l.isClassDef) color = MINIMAP.classDef;
              else if (l.isDefLine) color = MINIMAP.defLine;
              else if (l.isImport) color = MINIMAP.import;
              else if (!l.html.trim()) color = 'transparent';
              return <div key={l.lineNum} style={{ height: Math.max(1, inspectorHeight / renderedLines.length), backgroundColor: color }} />;
            })}
          </div>
        </div>
      )}
    </section>
  );
}
