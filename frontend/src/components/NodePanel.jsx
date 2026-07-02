import { useEffect, useRef, useState } from 'react';

export default function NodePanel({ node, graph, onClose, onNodeClick }) {
  const panelRef = useRef(null);
  const [isMobile, setIsMobile] = useState(window.innerWidth < 640);

  useEffect(() => {
    const handleResize = () => setIsMobile(window.innerWidth < 640);
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  useEffect(() => {
    if (!node) return;

    // Focus trap setup
    if (panelRef.current) {
      panelRef.current.focus();
    }

    const handleKeyDown = (e) => {
      if (e.key === 'Escape') {
        onClose();
      }
    };
    
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [node, onClose]);

  if (!node) return null;

  // Compute colors for header badge
  let badgeClasses = "";
  if (node.type === 'file') badgeClasses = "bg-blue-500/10 border-blue-500/30 text-blue-400";
  else if (node.type === 'function') badgeClasses = "bg-purple-500/10 border-purple-500/30 text-purple-400";
  else if (node.type === 'class') badgeClasses = "bg-amber-500/10 border-amber-500/30 text-amber-400";

  // Helpers for list rendering
  const getNodeColor = (type) => {
    if (type === 'file') return 'bg-blue-500';
    if (type === 'function') return 'bg-purple-500';
    if (type === 'class') return 'bg-amber-500';
    return 'bg-gray-500';
  };

  const getCallers = () => {
    if (!graph?.edges) return [];
    return graph.edges
      .filter(e => e.target === node.id && e.type === "calls")
      .map(e => graph.nodes.find(n => n.id === e.source))
      .filter(Boolean);
  };

  const getCallees = () => {
    if (!graph?.edges) return [];
    return graph.edges
      .filter(e => e.source === node.id && e.type === "calls")
      .map(e => graph.nodes.find(n => n.id === e.target))
      .filter(Boolean);
  };

  const callers = getCallers();
  const callees = getCallees();

  const inDegree = graph?.edges?.filter(e => e.target === node.id).length || 0;
  const outDegree = graph?.edges?.filter(e => e.source === node.id).length || 0;

  const renderNodeList = (list) => {
    if (list.length === 0) {
      return <div className="text-xs text-muted italic">Not called by any function in this repo</div>;
    }
    const maxVisible = 8;
    const visibleList = list.slice(0, maxVisible);
    const hiddenCount = list.length - maxVisible;

    return (
      <div className="space-y-1">
        {visibleList.map(item => (
          <div 
            key={item.id} 
            onClick={() => onNodeClick(item)}
            className="flex items-center gap-2 py-1.5 px-2 rounded hover:bg-surface-hover cursor-pointer transition-colors group"
          >
            <div className={`w-2 h-2 rounded-full flex-shrink-0 ${getNodeColor(item.type)}`} />
            <div className="font-mono text-xs text-white/80 group-hover:text-white truncate flex-1">
              {item.label}
            </div>
            <div className="text-xs text-muted truncate max-w-[80px]" title={item.file}>
              {item.file.split('/').pop()}
            </div>
          </div>
        ))}
        {hiddenCount > 0 && (
          <div className="text-xs text-muted font-mono px-2 py-1">+ {hiddenCount} more</div>
        )}
      </div>
    );
  };

  return (
    <div className="absolute inset-0 z-20 pointer-events-none overflow-hidden">
      <div
        ref={panelRef}
        tabIndex={-1}
        className={`pointer-events-auto absolute bg-surface border-border flex flex-col shadow-2xl transition-transform duration-250 ease-out outline-none
          sm:right-0 sm:top-0 sm:h-full sm:w-80 sm:border-l sm:translate-x-0
          max-sm:bottom-0 max-sm:left-0 max-sm:w-full max-sm:h-[60vh] max-sm:border-t max-sm:translate-y-0
        `}
        style={{ animation: isMobile ? 'slideUpPanel 250ms ease-out' : 'slideInRight 250ms ease-out' }}
      >
        <style>{`
          @keyframes slideInRight {
            from { transform: translateX(100%); }
            to { transform: translateX(0); }
          }
          @keyframes slideUpPanel {
            from { transform: translateY(100%); }
            to { transform: translateY(0); }
          }
        `}</style>

        {isMobile && (
          <div className="w-10 h-1 bg-border rounded-full mx-auto mt-2 mb-1 flex-shrink-0" />
        )}

        {/* Header */}
        <div className="h-12 border-b border-border px-4 flex items-center justify-between flex-shrink-0">
          <div className="flex items-center min-w-0">
            <span className={`rounded-full px-2 py-0.5 text-xs font-mono font-medium uppercase tracking-wider border flex-shrink-0 ${badgeClasses}`}>
              {node.type}
            </span>
            <span className="text-white font-mono font-medium text-sm ml-2 truncate max-w-[180px]" title={node.label}>
              {node.label}
            </span>
          </div>
          <button 
            onClick={onClose}
            className="text-muted hover:text-white transition-colors w-8 h-8 flex items-center justify-center rounded hover:bg-surface-hover flex-shrink-0 ml-2"
          >
            ×
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto px-4 py-3 space-y-6">
          
          {/* Section 1 - Summary */}
          {node.summary !== undefined && (
            <div>
              <div className="text-xs font-mono text-muted uppercase tracking-wider mb-2">What it does</div>
              {node.summary ? (
                <div className="text-sm text-white/90 leading-relaxed bg-surface-hover rounded-lg p-3 border border-border font-sans">
                  {node.summary}
                </div>
              ) : (
                <div className="text-xs text-muted italic">No summary available</div>
              )}
            </div>
          )}

          {/* Section 2 - Location */}
          <div>
            <div className="text-xs font-mono text-muted uppercase tracking-wider mb-2">Location</div>
            <div className="flex flex-wrap items-center gap-2">
              <div 
                className="bg-surface border border-border rounded px-2 py-1 font-mono text-xs text-blue-400 max-w-[200px]"
                style={{ direction: 'rtl', textOverflow: 'ellipsis', whiteSpace: 'nowrap', overflow: 'hidden', textAlign: 'left' }}
                title={node.file}
              >
                <bdo dir="ltr">{node.file}</bdo>
              </div>
              {node.lines && node.lines.length === 2 && (
                <div className="text-xs text-muted font-mono">
                  Lines {node.lines[0]}–{node.lines[1]}
                </div>
              )}
              {node.is_entry_point && (
                <div className="text-xs font-mono text-green-400 bg-green-500/10 border border-green-500/30 rounded-full px-2 py-0.5 inline-block">
                  ⬆ Entry Point
                </div>
              )}
            </div>
          </div>

          {/* Section 3 & 4 - Callers / Callees (Not for files) */}
          {node.type !== 'file' && (
            <>
              <div>
                <div className="text-xs font-mono text-muted uppercase tracking-wider mb-2">Called By ({callers.length})</div>
                {renderNodeList(callers)}
              </div>
              <div>
                <div className="text-xs font-mono text-muted uppercase tracking-wider mb-2">Calls ({callees.length})</div>
                {renderNodeList(callees)}
              </div>
            </>
          )}

          {/* Section 5 - Parameters */}
          {node.type === 'function' && node.parameters?.length > 0 && (
            <div>
              <div className="text-xs font-mono text-muted uppercase tracking-wider mb-2">Parameters</div>
              <div className="flex flex-wrap gap-1.5">
                {node.parameters.map((p, i) => (
                  <span key={i} className="bg-surface border border-border rounded px-2 py-0.5 font-mono text-xs text-purple-300">
                    {p}
                  </span>
                ))}
              </div>
            </div>
          )}

          {/* Section 6 - Base classes */}
          {node.type === 'class' && node.base_classes?.length > 0 && (
            <div>
              <div className="text-xs font-mono text-muted uppercase tracking-wider mb-2">Inherits From</div>
              <div className="flex flex-wrap gap-1.5">
                {node.base_classes.map((bc, i) => (
                  <span key={i} className="bg-surface border border-border rounded px-2 py-0.5 font-mono text-xs text-amber-300">
                    {bc}
                  </span>
                ))}
              </div>
            </div>
          )}

          {/* Section 7 - Metrics */}
          <div>
            <div className="text-xs font-mono text-muted uppercase tracking-wider mb-2">Metrics</div>
            <div className="bg-surface border border-border rounded-lg p-3 grid grid-cols-2 gap-2">
              <div className="space-y-0.5">
                <div className="text-xs text-muted font-mono">Centrality</div>
                <div className="text-sm text-white font-mono font-medium">{((node.centrality || 0) * 100).toFixed(1)}%</div>
              </div>
              <div className="space-y-0.5">
                <div className="text-xs text-muted font-mono">Layer</div>
                <div className="text-sm text-white font-mono font-medium">{node.layer ?? "—"}</div>
              </div>
              <div className="space-y-0.5">
                <div className="text-xs text-muted font-mono">Component</div>
                <div className="text-sm text-white font-mono font-medium">#{node.component ?? "—"}</div>
              </div>
              <div className="space-y-0.5">
                <div className="text-xs text-muted font-mono">In-degree</div>
                <div className="text-sm text-white font-mono font-medium">{inDegree}</div>
              </div>
              <div className="space-y-0.5">
                <div className="text-xs text-muted font-mono">Out-degree</div>
                <div className="text-sm text-white font-mono font-medium">{outDegree}</div>
              </div>
            </div>
          </div>

          {/* Section 8 - Docstring */}
          {node.docstring && node.docstring.trim() !== "" && (
            <div>
              <div className="text-xs font-mono text-muted uppercase tracking-wider mb-2">Docstring</div>
              <pre className="bg-surface border border-border rounded-lg p-3 font-mono text-xs text-white/70 leading-relaxed whitespace-pre-wrap max-h-32 overflow-y-auto">
                {node.docstring}
              </pre>
            </div>
          )}
          
        </div>
      </div>
    </div>
  );
}
