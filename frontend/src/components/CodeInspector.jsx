import { useState, useEffect, useRef, useMemo } from 'react';
import hljs from 'highlight.js/lib/core';
import python from 'highlight.js/lib/languages/python';
import { fetchFileSource } from '../api';

hljs.registerLanguage('python', python);

export default function CodeInspector({ 
  jobId, 
  filePath, 
  graph, 
  selectedNodeId, 
  onClose, 
  onNodeClick, 
  onFileSelect, 
  repo, 
  commitSha 
}) {
  const [inspectorHeight, setInspectorHeight] = useState(() => Math.floor(window.innerHeight * 0.45));
  const [isResizing, setIsResizing] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState(null);
  const [sourceCode, setSourceCode] = useState("");
  const [hoveredLine, setHoveredLine] = useState(null);

  const lineNumbersRef = useRef(null);
  const codeRef = useRef(null);

  // ---------------------------------------------------------------------------
  // Resizing
  // ---------------------------------------------------------------------------
  useEffect(() => {
    if (!isResizing) return;
    const handleMouseMove = (e) => {
      const newHeight = window.innerHeight - e.clientY;
      setInspectorHeight(Math.min(Math.max(newHeight, 200), window.innerHeight * 0.8));
    };
    const handleMouseUp = () => setIsResizing(false);
    
    document.addEventListener("mousemove", handleMouseMove);
    document.addEventListener("mouseup", handleMouseUp);
    return () => {
      document.removeEventListener("mousemove", handleMouseMove);
      document.removeEventListener("mouseup", handleMouseUp);
    };
  }, [isResizing]);

  // ---------------------------------------------------------------------------
  // Fetch Source
  // ---------------------------------------------------------------------------
  useEffect(() => {
    if (!filePath || !jobId) return;
    
    let isMounted = true;
    const loadSource = async () => {
      setIsLoading(true);
      setError(null);
      setSourceCode("");
      
      try {
        const res = await fetchFileSource(jobId, filePath);
        if (isMounted) {
          setSourceCode(res.content || "");
        }
      } catch (err) {
        if (isMounted) {
          setError(err.message);
        }
      } finally {
        if (isMounted) {
          setIsLoading(false);
        }
      }
    };
    
    loadSource();
    return () => { isMounted = false; };
  }, [filePath, jobId]);

  // ---------------------------------------------------------------------------
  // Graph Cross-referencing
  // ---------------------------------------------------------------------------
  const fileNodes = useMemo(() => {
    return graph?.nodes.filter(n => n.file === filePath) || [];
  }, [graph, filePath]);

  const fileEdges = useMemo(() => {
    return graph?.edges.filter(e => {
      const srcId = typeof e.source === 'object' ? e.source.id : e.source;
      return srcId.startsWith(filePath);
    }) || [];
  }, [graph, filePath]);

  const importsMap = useMemo(() => {
    // simple map: lineNumber -> boolean (or module name)
    const m = {};
    for (const edge of fileEdges) {
      if (edge.type === "imports") {
        // Unfortunately, AST import line numbers might not be perfectly mapped in edges.
        // For visual, we'll try to find "import" in the actual line text later.
      }
    }
    return m; // Actually, we'll process imports per line directly via text content
  }, [fileEdges]);

  // Function / Class line ranges for highlighting
  const highlightedRanges = useMemo(() => {
    const ranges = new Set();
    for (const node of fileNodes) {
      if (!node.lines || node.lines.length < 2) continue;
      const [start, end] = node.lines;
      
      if (node.id === selectedNodeId) {
        // Selected: highlight full body
        for (let l = start; l <= end; l++) ranges.add(l);
      } else {
        // Not selected: highlight only the definition line
        ranges.add(start);
      }
    }
    return ranges;
  }, [fileNodes, selectedNodeId]);

  // Scroll to selected node
  useEffect(() => {
    if (!selectedNodeId || !codeRef.current || !sourceCode) return;
    const node = fileNodes.find(n => n.id === selectedNodeId);
    if (!node || !node.lines || node.lines.length === 0) return;
    
    const targetLine = node.lines[0];
    const targetScrollTop = Math.max(0, (targetLine - 5) * 21);
    codeRef.current.scrollTo({ top: targetScrollTop, behavior: "smooth" });
  }, [selectedNodeId, fileNodes, sourceCode]);

  // ---------------------------------------------------------------------------
  // Render Pre-processing
  // ---------------------------------------------------------------------------
  const renderedLines = useMemo(() => {
    if (!sourceCode) return [];
    const highlighted = hljs.highlight(sourceCode, { language: "python" });
    const lines = highlighted.value.split('\n');
    
    // Call sites mapping (approximate based on function ranges)
    const callSitesByLine = {};
    for (const edge of fileEdges) {
      if (edge.type === "calls") {
        const srcId = typeof edge.source === 'object' ? edge.source.id : edge.source;
        const tgtId = typeof edge.target === 'object' ? edge.target.id : edge.target;
        const callerNode = fileNodes.find(n => n.id === srcId);
        
        if (callerNode && callerNode.lines) {
          // just attach it to the caller's def line for simplicity
          const defLine = callerNode.lines[0];
          if (!callSitesByLine[defLine]) callSitesByLine[defLine] = new Set();
          callSitesByLine[defLine].add(tgtId.split("::").pop());
        }
      }
    }

    return lines.map((htmlStr, idx) => {
      const lineNum = idx + 1;
      let lineHtml = htmlStr;

      // 1. Clickable function/class names
      for (const node of fileNodes) {
        if (node.type === "file") continue;
        const label = node.label || node.id.split("::").pop();
        if (label) {
          const pattern = new RegExp(`(<span class="hljs-title">)(${label})(</span>)`, "g");
          if (pattern.test(lineHtml)) {
             lineHtml = lineHtml.replace(pattern, 
              `$1<span class="codegraph-fn-link" data-id="${node.id}" style="cursor:pointer;border-bottom:1px dotted currentColor; pointer-events: auto;">$2</span>$3`
            );
          }
        }
      }

      // 2. Identify imports
      const isImport = lineHtml.includes('<span class="hljs-keyword">import</span>') || 
                       lineHtml.includes('<span class="hljs-keyword">from</span>');
      
      const calls = callSitesByLine[lineNum] ? Array.from(callSitesByLine[lineNum]) : [];

      return {
        lineNum,
        html: lineHtml,
        isImport,
        calls,
        isHighlighted: highlightedRanges.has(lineNum),
        isDefLine: fileNodes.some(n => n.lines && n.lines[0] === lineNum),
        isClassDef: fileNodes.some(n => n.type === "class" && n.lines && n.lines[0] === lineNum)
      };
    });
  }, [sourceCode, fileNodes, fileEdges, highlightedRanges]);

  // ---------------------------------------------------------------------------
  // Sync Scroll
  // ---------------------------------------------------------------------------
  const handleScroll = (e) => {
    const target = e.target;
    if (target === codeRef.current && lineNumbersRef.current) {
      lineNumbersRef.current.scrollTop = target.scrollTop;
    } else if (target === lineNumbersRef.current && codeRef.current) {
      codeRef.current.scrollTop = target.scrollTop;
    }
  };

  // ---------------------------------------------------------------------------
  // Click Handlers
  // ---------------------------------------------------------------------------
  const handleCodeClick = (e) => {
    const link = e.target.closest("[data-id]");
    if (!link) return;
    const nodeId = link.dataset.id;
    const node = graph?.nodes.find(n => n.id === nodeId);
    if (node && onNodeClick) {
      onNodeClick(node);
    }
  };

  const handleMinimapClick = (e) => {
    if (!codeRef.current || renderedLines.length === 0) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const ratio = (e.clientY - rect.top) / rect.height;
    const targetLine = Math.floor(ratio * renderedLines.length);
    codeRef.current.scrollTop = targetLine * 21;
  };

  // ---------------------------------------------------------------------------
  // UI Components
  // ---------------------------------------------------------------------------
  if (!filePath) return null;

  const fnCount = fileNodes.filter(n => n.type === "function").length;
  const classCount = fileNodes.filter(n => n.type === "class").length;
  const totalLines = renderedLines.length;

  return (
    <div 
      className="absolute bottom-0 left-0 right-0 bg-bg border-t border-border flex flex-col z-20 animate-slide-up shadow-2xl"
      style={{ height: `${inspectorHeight}px` }}
    >
      {/* Resize Handle */}
      <div 
        className="w-full h-1 cursor-ns-resize bg-border hover:bg-accent/60 transition-colors flex-shrink-0"
        onMouseDown={() => setIsResizing(true)}
      >
        <div className="w-8 h-0.5 bg-[#4b5563] rounded-full mx-auto mt-[1px]" />
      </div>

      {/* Header */}
      <div className="h-10 flex-shrink-0 bg-surface border-b border-border px-4 flex items-center gap-3">
        <div className="w-2 h-2 rounded-full bg-node-file flex-shrink-0" />
        <div className="flex items-center">
          {filePath.split("/").map((part, i, arr) => (
            <span key={i} className="flex items-center">
              <span className={`font-mono text-xs ${i === arr.length - 1 ? "text-white font-medium" : "text-muted hover:text-white cursor-pointer"}`}>
                {part}
              </span>
              {i < arr.length - 1 && <span className="text-border font-mono text-xs mx-0.5">/</span>}
            </span>
          ))}
        </div>

        <div className="ml-auto flex items-center gap-4">
          <span className="text-xs font-mono text-muted">{totalLines > 0 ? `${totalLines} lines` : ""}</span>
          {fnCount > 0 && <span className="text-xs font-mono text-purple-400">{fnCount} functions</span>}
          {classCount > 0 && <span className="text-xs font-mono text-amber-400">{classCount} classes</span>}
        </div>

        <a
          href={`https://github.com/${repo}/blob/${commitSha}/${filePath}`}
          target="_blank"
          rel="noopener noreferrer"
          className="text-muted hover:text-white text-sm transition-colors cursor-pointer ml-2"
          title="Open in GitHub"
        >
          ↗
        </a>
        <button
          onClick={onClose}
          className="w-7 h-7 flex items-center justify-center text-muted hover:text-white rounded hover:bg-surface-hover transition-colors ml-1 text-lg leading-none pb-0.5"
        >
          ×
        </button>
      </div>

      {/* Body */}
      {isLoading && (
        <div className="flex-1 flex items-center justify-center bg-bg">
          <div className="text-center space-y-3">
            <div className="w-5 h-5 border-2 border-accent border-t-transparent rounded-full animate-spin mx-auto" />
            <div className="text-xs font-mono text-muted">Loading source...</div>
          </div>
        </div>
      )}

      {error && !isLoading && (
        <div className="flex-1 flex items-center justify-center bg-bg">
          <div className="text-center space-y-2">
            <div className="text-2xl">⚠️</div>
            <div className="text-xs font-mono text-error">Could not load source for {filePath}</div>
            <div className="text-xs font-mono text-muted max-w-xs mx-auto">
              Source files are only available during the session. Re-analyze the repo to reload.
            </div>
          </div>
        </div>
      )}

      {!isLoading && !error && sourceCode && (
        <div className="flex-1 overflow-hidden flex relative">
          
          {/* Line Numbers */}
          <div 
            ref={lineNumbersRef}
            className="w-10 overflow-y-auto flex-shrink-0 bg-surface/30 border-r border-border hide-scrollbar"
            onScroll={handleScroll}
            style={{ paddingBottom: '50px' }} // extra padding for overscroll
          >
            {renderedLines.map(l => (
              <div 
                key={l.lineNum} 
                className="h-[21px] flex items-center justify-end pr-3 font-mono text-xs text-muted select-none"
              >
                {l.lineNum}
              </div>
            ))}
          </div>

          {/* Code */}
          <div 
            ref={codeRef}
            className="flex-1 overflow-auto relative bg-bg"
            onScroll={handleScroll}
            onClick={handleCodeClick}
            style={{ paddingBottom: '50px' }}
          >
            {renderedLines.map(l => (
              <div
                key={l.lineNum}
                className={`
                  h-[21px] px-4 font-mono text-xs leading-[21px] whitespace-pre relative group flex items-center
                  ${l.isHighlighted ? "bg-accent/10 border-l-2 border-accent" : "border-l-2 border-transparent"}
                  ${hoveredLine === l.lineNum ? "bg-surface-hover" : ""}
                  ${l.isImport ? "border-l-2 !border-blue-500/50 bg-blue-500/5" : ""}
                `}
                onMouseEnter={() => setHoveredLine(l.lineNum)}
                onMouseLeave={() => setHoveredLine(null)}
              >
                <div 
                  className="flex-1 overflow-hidden text-ellipsis"
                  dangerouslySetInnerHTML={{ __html: l.html || " " }} 
                />
                
                {l.calls.length > 0 && (
                  <div className="absolute right-4 top-0 h-full flex items-center opacity-0 group-hover:opacity-100 transition-opacity bg-surface-hover/80 pl-2 backdrop-blur-sm pointer-events-none">
                    <span className="text-xs font-mono text-accent/80">→ {l.calls.join(", ")}</span>
                  </div>
                )}
              </div>
            ))}
          </div>

          {/* Minimap */}
          <div 
            className="hidden md:block w-[60px] flex-shrink-0 bg-surface/20 border-l border-border relative cursor-pointer"
            onClick={handleMinimapClick}
          >
            {renderedLines.map(l => {
              let color = "rgba(226, 232, 240, 0.15)"; // default
              if (l.isHighlighted && selectedNodeId) color = "rgba(124, 58, 237, 0.9)"; // selected
              else if (l.isClassDef) color = "rgba(245, 158, 11, 0.6)";
              else if (l.isDefLine) color = "rgba(124, 58, 237, 0.6)";
              else if (l.isImport) color = "rgba(59, 130, 246, 0.4)";
              else if (l.html.trim() === "") color = "transparent";

              return (
                <div 
                  key={l.lineNum}
                  style={{ 
                    height: `${Math.max(1, inspectorHeight / totalLines)}px`,
                    backgroundColor: color,
                    width: '100%'
                  }}
                />
              );
            })}
            
            {/* Viewport Indicator - highly simplified based on scroll */}
            <div 
              className="absolute left-0 right-0 bg-white/10 border border-white/20 pointer-events-none transition-all duration-75"
              style={{
                top: codeRef.current ? `${(codeRef.current.scrollTop / codeRef.current.scrollHeight) * 100}%` : '0%',
                height: codeRef.current ? `${(codeRef.current.clientHeight / codeRef.current.scrollHeight) * 100}%` : '10%'
              }}
            />
          </div>

        </div>
      )}
    </div>
  );
}
