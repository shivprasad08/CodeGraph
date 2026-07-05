import { useRef, useState, useEffect, useMemo, useCallback } from 'react';
import ForceGraph2D from 'react-force-graph-2d';
import { groupNodesByDirectory, getTopLevelDir } from '../utils/directoryColors';
import { computeConvexHull, expandHull, drawRoundedHull } from '../utils/hullUtils';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function computeNodeSize(node) {
  let baseSize = 3;
  if (node.type === 'file') baseSize = 6;
  else if (node.type === 'class') baseSize = 5;
  
  let centralityBonus = 1 + ((node.centrality || 0) * 8);
  let multiplier = node.is_entry_point ? 1.5 : 1.0;
  
  let size = baseSize * centralityBonus * multiplier;
  return Math.min(Math.max(size, 2), 20); // Clamp between 2 and 20
}

function computeNodeColor(node) {
  if (node.is_entry_point) return "#22c55e"; // green
  if (node.type === 'file') return "#3b82f6"; // blue
  if (node.type === 'class') return "#f59e0b"; // amber
  return "#7c3aed"; // function node - purple
}

function computeEdgeColor(type) {
  if (type === 'calls') return "rgba(124, 58, 237, 0.4)";
  if (type === 'imports') return "rgba(59, 130, 246, 0.3)";
  if (type === 'defines') return "rgba(34, 197, 94, 0.25)";
  if (type === 'contains') return "rgba(245, 158, 11, 0.3)";
  return "rgba(255, 255, 255, 0.2)";
}

function computeEdgeWidth(type) {
  if (type === 'calls') return 1.5;
  if (type === 'imports') return 1.0;
  if (type === 'defines') return 0.8;
  if (type === 'contains') return 0.8;
  return 0.5;
}

// ---------------------------------------------------------------------------
// GraphCanvas Component
// ---------------------------------------------------------------------------
export default function GraphCanvas({ 
  graph, 
  onNodeClick, 
  selectedNodeId, 
  highlightedNodeIds = new Set(),
  chatHighlightedNodeIds = new Set(),
  zoomToNodes,
  dirColorMap = {},
  blastRadius = null,
  simulationMode = false,
  onExitSimulation
}) {
  const fgRef = useRef();
  const containerRef = useRef();
  
  const [dimensions, setDimensions] = useState({ width: 800, height: 600 });
  const [simulationDone, setSimulationDone] = useState(false);
  
  const [hullsVisible, setHullsVisible] = useState(true);
  const [hullOpacity, setHullOpacity] = useState(0);
  const [hiddenDirs, setHiddenDirs] = useState(new Set());
  
  const cachedHulls = useRef(null);
  const cachedHullsForced = useRef(false);

  // Use refs for canvas render cycle to avoid re-renders on hover
  const hoveredNodeIdRef = useRef(null);
  const selectedNodeIdRef = useRef(selectedNodeId);
  const highlightedNodeIdsRef = useRef(highlightedNodeIds);
  const chatHighlightedNodeIdsRef = useRef(chatHighlightedNodeIds);

  const dirGroups = useMemo(() => {
    if (!graph?.nodes) return {};
    return groupNodesByDirectory(graph.nodes);
  }, [graph]);

  useEffect(() => {
    if (simulationDone) {
      let opacity = 0;
      const interval = setInterval(() => {
        opacity += 0.05;
        setHullOpacity(Math.min(opacity, 1));
        if (opacity >= 1) clearInterval(interval);
      }, 30);
      return () => clearInterval(interval);
    }
  }, [simulationDone]);

  // Sync refs
  useEffect(() => {
    highlightedNodeIdsRef.current = highlightedNodeIds;
    cachedHullsForced.current = true;
  }, [highlightedNodeIds]);
  
  useEffect(() => {
    chatHighlightedNodeIdsRef.current = chatHighlightedNodeIds;
    cachedHullsForced.current = true;
  }, [chatHighlightedNodeIds]);

  useEffect(() => {
    cachedHullsForced.current = true;
  }, [hiddenDirs, hullsVisible]);

  // Sync selectedNodeId prop to ref
  useEffect(() => {
    selectedNodeIdRef.current = selectedNodeId;
    
    // Zoom to node if externally selected and it exists
    if (selectedNodeId && fgRef.current && graph?.nodes) {
      const node = graph.nodes.find(n => n.id === selectedNodeId);
      if (node && node.x !== undefined && node.y !== undefined) {
        fgRef.current.centerAt(node.x, node.y, 600);
        fgRef.current.zoom(4, 600);
      }
    }
  }, [selectedNodeId, graph]);

  // Handle zoomToNodes
  useEffect(() => {
    if (!zoomToNodes?.length || !fgRef.current || !graph?.nodes) return;
    
    const targetNodes = graph.nodes.filter(n => zoomToNodes.includes(n.id));
    
    if (!targetNodes.length) return;
    
    if (targetNodes.length === 1) {
      // Find the actual node object in force graph if it has x,y
      const fgNode = fgRef.current.graphData?.().nodes.find(n => n.id === targetNodes[0].id) || targetNodes[0];
      if (fgNode.x !== undefined && fgNode.y !== undefined) {
        fgRef.current.centerAt(fgNode.x, fgNode.y, 600);
        fgRef.current.zoom(5, 600);
      }
    } else {
      fgRef.current.zoomToFit(400, 80, n => zoomToNodes.includes(n.id));
    }
  }, [zoomToNodes, graph]);

  // Responsive sizing
  useEffect(() => {
    if (!containerRef.current) return;
    const observer = new ResizeObserver(entries => {
      const { width, height } = entries[0].contentRect;
      setDimensions({ width, height });
    });
    observer.observe(containerRef.current);
    return () => observer.disconnect();
  }, []);

  // Configure force simulation on mount
  useEffect(() => {
    if (!fgRef.current) return;
    const fg = fgRef.current;
    
    fg.d3Force("charge").strength(-300);
    fg.d3Force("link").distance(link => {
      if (link.type === "defines" || link.type === "contains") return 80;
      return 40;
    });
    fg.d3Force("center").strength(0.05);
    
    fg.d3ReheatSimulation();
  }, [graph]);

  // Transform graph data
  const transformedGraph = useMemo(() => {
    if (!graph || !graph.nodes || !graph.edges) return { nodes: [], links: [] };
    return {
      nodes: graph.nodes.map(n => {
        let size = computeNodeSize(n);
        let color = computeNodeColor(n);
        
        if (simulationMode && blastRadius) {
          const data = blastRadius.affected.get(n.id);
          if (!data) {
            color = "rgba(255, 255, 255, 0.08)";
            size = size * 0.4;
          } else {
            switch(data.severity) {
              case "source":   color = "#ffffff"; size = size * 1.8; break;
              case "critical": color = "#ef4444"; size = size * (1 + (1 - data.depth/6) * 0.5); break;
              case "high":     color = "#f97316"; size = size * (1 + (1 - data.depth/6) * 0.5); break;
              case "medium":   color = "#f59e0b"; size = size * (1 + (1 - data.depth/6) * 0.5); break;
              case "low":      color = "#6b7280"; size = size * (1 + (1 - data.depth/6) * 0.5); break;
              default:         break;
            }
          }
        }
        
        return {
          ...n,
          val: size,
          color: color
        };
      }),
      links: graph.edges.map(e => ({
        ...e,
        source: e.source,
        target: e.target,
        color: computeEdgeColor(e.type),
        width: computeEdgeWidth(e.type)
      }))
    };
  }, [graph]);

  // Empty state check
  if (!graph || graph.nodes?.length === 0) {
    return (
      <div className="w-full h-full flex items-center justify-center text-muted font-mono text-sm">
        No nodes to display. The repo may be empty or unparseable.
      </div>
    );
  }

  // -------------------------------------------------------------------------
  // Interaction Handlers
  // -------------------------------------------------------------------------
  const handleNodeClick = (node) => {
    if (onNodeClick) onNodeClick(node);
  };

  const handleNodeHover = (node) => {
    hoveredNodeIdRef.current = node ? node.id : null;
    document.body.style.cursor = node ? "pointer" : "default";
  };

  const handleBackgroundClick = () => {
    if (onNodeClick) onNodeClick(null);
  };

  const preventContextMenu = (e) => {
    e.preventDefault();
    if (fgRef.current) {
      fgRef.current.zoomToFit(400, 40);
    }
  };

  // -------------------------------------------------------------------------
  // Renderers
  // -------------------------------------------------------------------------
  const drawHulls = useCallback((ctx) => {
    if (!hullsVisible || hullOpacity === 0) return;
    
    if (simulationDone && cachedHulls.current && !cachedHullsForced.current) {
      cachedHulls.current.forEach(({ expanded, dir, color, topPoint, label, isActiveDir, isInactive }) => {
        if (hiddenDirs.has(dir)) return;
        ctx.save();
        ctx.globalAlpha = hullOpacity;
        
        drawRoundedHull(ctx, expanded, 14);
        ctx.fillStyle = isActiveDir ? color.fill.replace("0.06", "0.15")
                      : isInactive ? color.fill.replace("0.06", "0.02")
                      : color.fill;
        ctx.fill();
        
        drawRoundedHull(ctx, expanded, 14);
        ctx.strokeStyle = color.stroke;
        ctx.lineWidth = 1.5;
        if (isActiveDir) ctx.setLineDash([]);
        else ctx.setLineDash([6, 4]);
        ctx.globalAlpha = (isActiveDir ? 0.7 : isInactive ? 0.1 : 0.35) * hullOpacity;
        ctx.stroke();
        ctx.setLineDash([]);
        
        ctx.globalAlpha = hullOpacity;
        ctx.font = "bold 11px JetBrains Mono, monospace";
        ctx.textAlign = "center";
        ctx.textBaseline = "bottom";
        
        const textWidth = ctx.measureText(label).width;
        const pillW = textWidth + 16;
        const pillH = 18;
        const pillX = topPoint.x - pillW / 2;
        const pillY = topPoint.y - pillH - 4;
        
        ctx.fillStyle = "rgba(10, 10, 15, 0.85)";
        ctx.beginPath();
        if (ctx.roundRect) {
          ctx.roundRect(pillX, pillY, pillW, pillH, 4);
        } else {
          ctx.rect(pillX, pillY, pillW, pillH); // Fallback
        }
        ctx.fill();
        
        ctx.strokeStyle = color.stroke;
        ctx.lineWidth = 1;
        ctx.beginPath();
        if (ctx.roundRect) {
          ctx.roundRect(pillX, pillY, pillW, pillH, 4);
        } else {
          ctx.rect(pillX, pillY, pillW, pillH);
        }
        ctx.stroke();
        
        ctx.fillStyle = color.label;
        ctx.fillText(label, topPoint.x, topPoint.y - 4);
        ctx.restore();
      });
      return;
    }
    
    const liveNodes = graph?.nodes ?? [];
    const posMap = {};
    for (const n of liveNodes) {
      posMap[n.id] = { x: n.x ?? 0, y: n.y ?? 0 };
    }
    
    let activeDir = null;
    if (highlightedNodeIds.size > 0 && graph?.nodes) {
      const activeNode = graph.nodes.find(n => highlightedNodeIds.has(n.id));
      if (activeNode) {
        activeDir = getTopLevelDir(activeNode.file || activeNode.id);
      }
    }
    
    const freshHulls = [];
    
    for (const [dir, dirNodes] of Object.entries(dirGroups)) {
      const color = dirColorMap[dir];
      if (!color) continue;
      
      const points = dirNodes
        .map(n => posMap[n.id])
        .filter(p => p && isFinite(p.x) && isFinite(p.y));
        
      if (points.length < 2) continue;
      const hull = computeConvexHull(points);
      if (hull.length < 2) continue;
      
      const expanded = expandHull(hull, 30);
      const topPoint = expanded.reduce((top, p) => p.y < top.y ? p : top, expanded[0]);
      const label = dir === "__root__" ? "root" : dir;
      const isActiveDir = dir === activeDir;
      const isInactive = activeDir !== null && !isActiveDir;
      
      freshHulls.push({ expanded, dir, color, topPoint, label, isActiveDir, isInactive });
      
      if (hiddenDirs.has(dir)) continue;

      ctx.save();
      ctx.globalAlpha = hullOpacity;
      
      drawRoundedHull(ctx, expanded, 14);
      ctx.fillStyle = isActiveDir ? color.fill.replace("0.06", "0.15")
                    : isInactive ? color.fill.replace("0.06", "0.02")
                    : color.fill;
      ctx.fill();
      
      drawRoundedHull(ctx, expanded, 14);
      ctx.strokeStyle = color.stroke;
      ctx.lineWidth = 1.5;
      if (isActiveDir) ctx.setLineDash([]);
      else ctx.setLineDash([6, 4]);
      ctx.globalAlpha = (isActiveDir ? 0.7 : isInactive ? 0.1 : 0.35) * hullOpacity;
      ctx.stroke();
      ctx.setLineDash([]);
      
      ctx.globalAlpha = hullOpacity;
      ctx.font = "bold 11px JetBrains Mono, monospace";
      ctx.textAlign = "center";
      ctx.textBaseline = "bottom";
      
      const textWidth = ctx.measureText(label).width;
      const pillW = textWidth + 16;
      const pillH = 18;
      const pillX = topPoint.x - pillW / 2;
      const pillY = topPoint.y - pillH - 4;
      
      ctx.fillStyle = "rgba(10, 10, 15, 0.85)";
      ctx.beginPath();
      if (ctx.roundRect) {
        ctx.roundRect(pillX, pillY, pillW, pillH, 4);
      } else {
        ctx.rect(pillX, pillY, pillW, pillH); // Fallback
      }
      ctx.fill();
      
      ctx.strokeStyle = color.stroke;
      ctx.lineWidth = 1;
      ctx.beginPath();
      if (ctx.roundRect) {
        ctx.roundRect(pillX, pillY, pillW, pillH, 4);
      } else {
        ctx.rect(pillX, pillY, pillW, pillH);
      }
      ctx.stroke();
      
      ctx.fillStyle = color.label;
      ctx.fillText(label, topPoint.x, topPoint.y - 4);
      ctx.restore();
    }
    
    if (simulationDone) {
      cachedHulls.current = freshHulls;
      cachedHullsForced.current = false;
    }
  }, [dirGroups, dirColorMap, hullsVisible, hullOpacity, simulationDone, highlightedNodeIds, hiddenDirs, graph]);

  const nodeCanvasObject = (node, ctx, globalScale) => {
    const size = node.val;
    const isSelected = node.id === selectedNodeIdRef.current;
    const isHovered = node.id === hoveredNodeIdRef.current;
    const label = node.label;

    if (!Number.isFinite(node.x) || !Number.isFinite(node.y) || !Number.isFinite(size)) {
      return;
    }

    const hasHighlight = highlightedNodeIdsRef.current.size > 0;
    const isHighlighted = hasHighlight ? highlightedNodeIdsRef.current.has(node.id) : true;
    const isChatHighlighted = chatHighlightedNodeIdsRef.current?.has(node.id);
    
    ctx.globalAlpha = isHighlighted ? 1.0 : 0.15;

    // 0. Chat Highlight Glow
    if (isChatHighlighted && !simulationMode) {
      ctx.beginPath();
      ctx.arc(node.x, node.y, size * 3, 0, 2 * Math.PI);
      ctx.strokeStyle = node.color + "80"; // 50% opacity border
      ctx.lineWidth = 2 / globalScale; // keep border crisp
      ctx.stroke();
    }

    // 0.5 Simulation source pulsing ring
    if (simulationMode && blastRadius && blastRadius.affected.get(node.id)?.severity === "source") {
      const pulseRadius = size * 2.5 + Math.sin(Date.now() / 300) * size * 0.5;
      ctx.beginPath();
      ctx.arc(node.x, node.y, pulseRadius, 0, 2 * Math.PI);
      ctx.strokeStyle = "rgba(255, 255, 255, 0.3)";
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }

    // 1. Glow effect for entry points and hovered nodes
    if (node.is_entry_point || isHovered) {
      ctx.beginPath();
      ctx.arc(node.x, node.y, size * 2, 0, 2 * Math.PI);
      ctx.fillStyle = node.color + "33"; // 20% opacity instead of expensive radial gradient
      ctx.fill();
    }

    // 2. Main circle
    ctx.beginPath();
    ctx.arc(node.x, node.y, size, 0, 2 * Math.PI);
    ctx.fillStyle = node.color;
    if (isHovered) {
        ctx.fillStyle = "#ffffff";
        ctx.fill();
        ctx.fillStyle = node.color + "cc";
    }
    ctx.fill();
    
    if (node.issue_count > 0) {
      const badgeColor =
        node.issue_severity === "high"   ? "#ef4444" :
        node.issue_severity === "medium" ? "#f59e0b" :
        node.issue_severity === "low"    ? "#6b7280" : "#22c55e";
      
      const badgeR = 4;
      const badgeX = node.x + size * 0.7;
      const badgeY = node.y - size * 0.7;
      
      ctx.beginPath();
      ctx.arc(badgeX, badgeY, badgeR, 0, 2 * Math.PI);
      ctx.fillStyle = badgeColor;
      ctx.fill();
      ctx.strokeStyle = "#0a0a0f";
      ctx.lineWidth = 1;
      ctx.stroke();
      
      if (globalScale > 2 && node.issue_count <= 9 && !simulationMode) {
        ctx.font = `bold ${6 / globalScale}px sans-serif`;
        ctx.fillStyle = "#fff";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText(node.issue_count, badgeX, badgeY);
      }
    }
    
    // Highlight ring for nodes in a selected file
    if (hasHighlight && isHighlighted && !isSelected) {
      ctx.beginPath();
      ctx.arc(node.x, node.y, size + 1, 0, 2 * Math.PI);
      ctx.strokeStyle = node.color + "80";
      ctx.lineWidth = 1;
      ctx.stroke();
    }

    // 3. Selected ring
    if (isSelected) {
      ctx.beginPath();
      ctx.arc(node.x, node.y, size + 2, 0, 2 * Math.PI);
      ctx.strokeStyle = "#ffffff";
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }

    // 4. Label
    const fontSize = Math.max(8 / globalScale, 2);
    const showLabel = globalScale > 1.2 || node.is_entry_point || isSelected;
    if (showLabel) {
      ctx.font = `${fontSize}px JetBrains Mono, monospace`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      
      // Fast width calculation for monospace fonts instead of expensive ctx.measureText
      const textWidth = label.length * fontSize * 0.6;
      const bw = textWidth + 4;
      const bh = fontSize + 3;
      
      ctx.fillStyle = "rgba(10, 10, 15, 0.85)";
      ctx.fillRect(node.x - bw / 2, node.y + size + 2, bw, bh);
      
      ctx.fillStyle = isSelected ? "#ffffff" : "rgba(255,255,255,0.85)";
      ctx.fillText(label, node.x, node.y + size + 2 + bh / 2);
    }
    
    // Reset alpha just in case
    ctx.globalAlpha = 1.0;
  };

  const hasManyNodes = graph.nodes.length > 300;

  return (
    <div 
      ref={containerRef} 
      className={`w-full h-full relative ${simulationDone ? 'animate-fade-in' : ''}`}
      onContextMenu={preventContextMenu}
    >
      <ForceGraph2D
        ref={fgRef}
        graphData={transformedGraph}
        width={dimensions.width}
        height={dimensions.height}
        backgroundColor="#0a0a0f"
        
        onRenderFramePre={drawHulls}
        
        nodeCanvasObject={nodeCanvasObject}
        nodeCanvasObjectMode={() => "replace"}
        nodeLabel={node => ""}
        
        linkColor={link => {
          if (simulationMode && blastRadius) {
            const srcId = typeof link.source === 'object' ? link.source.id : link.source;
            const tgtId = typeof link.target === 'object' ? link.target.id : link.target;
            const sourceAffected = blastRadius.affected.has(srcId);
            const targetAffected = blastRadius.affected.has(tgtId);
            
            if (!sourceAffected && !targetAffected) return "rgba(255,255,255,0.03)";
            
            if (sourceAffected && targetAffected) {
              const srcData = blastRadius.affected.get(srcId);
              return srcData?.severity === "critical" ? "rgba(239,68,68,0.6)"
                   : srcData?.severity === "high"     ? "rgba(249,115,22,0.5)"
                   : "rgba(245,158,11,0.4)";
            }
            return "rgba(255,255,255,0.08)";
          }
          
          if (highlightedNodeIds.size === 0) return link.color;
          const srcId = typeof link.source === 'object' ? link.source.id : link.source;
          const tgtId = typeof link.target === 'object' ? link.target.id : link.target;
          return (highlightedNodeIds.has(srcId) || highlightedNodeIds.has(tgtId)) 
            ? link.color 
            : "rgba(255,255,255,0.03)";
        }}
        linkWidth={link => {
          if (simulationMode && blastRadius) {
            const srcId = typeof link.source === 'object' ? link.source.id : link.source;
            const tgtId = typeof link.target === 'object' ? link.target.id : link.target;
            const sourceAffected = blastRadius.affected.has(srcId);
            const targetAffected = blastRadius.affected.has(tgtId);
            if (sourceAffected && targetAffected) return 2.5;
            return 0.3;
          }
          return link.width;
        }}
        linkDirectionalArrowLength={link => link.type === "calls" ? 4 : 0}
        linkDirectionalArrowRelPos={1}
        linkDirectionalParticles={
          hasManyNodes && !simulationMode ? 0 : (link => {
            if (simulationMode && blastRadius) {
              const srcId = typeof link.source === 'object' ? link.source.id : link.source;
              const tgtId = typeof link.target === 'object' ? link.target.id : link.target;
              const sourceAffected = blastRadius.affected.has(srcId);
              const targetAffected = blastRadius.affected.has(tgtId);
              return (sourceAffected && targetAffected) ? 3 : 0;
            }
            return link.type === "calls" ? 2 : 0;
          })
        }
        linkDirectionalParticleSpeed={0.004}
        linkDirectionalParticleColor={link => {
          if (simulationMode) return "#ef4444";
          if (highlightedNodeIds.size === 0) return link.color;
          const srcId = typeof link.source === 'object' ? link.source.id : link.source;
          const tgtId = typeof link.target === 'object' ? link.target.id : link.target;
          return (highlightedNodeIds.has(srcId) || highlightedNodeIds.has(tgtId)) 
            ? link.color 
            : "rgba(255,255,255,0)";
        }}
        
        onNodeClick={handleNodeClick}
        onNodeHover={handleNodeHover}
        onBackgroundClick={handleBackgroundClick}
        
        cooldownTicks={200}
        warmupTicks={50}
        onEngineStop={() => setSimulationDone(true)}
      />

      {/* Loading Overlay */}
      {!simulationDone && (
        <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
          <div className="bg-surface/80 backdrop-blur rounded-lg px-4 py-2 flex items-center gap-2">
            <div className="w-2 h-2 rounded-full bg-accent animate-pulse"></div>
            <span className="font-mono text-sm text-muted">Simulating layout...</span>
          </div>
        </div>
      )}

      {/* Graph Controls Overlay */}
      <div className="absolute bottom-4 left-4 z-10 bg-surface/80 backdrop-blur border border-border rounded-lg p-1 space-y-1">
        <button 
          onClick={() => fgRef.current?.zoom(fgRef.current.zoom() * 1.4, 300)}
          className="w-8 h-8 flex items-center justify-center text-muted hover:text-white hover:bg-surface-hover rounded transition-colors text-sm font-mono font-bold"
          title="Zoom In"
        >
          +
        </button>
        <button 
          onClick={() => fgRef.current?.zoom(fgRef.current.zoom() / 1.4, 300)}
          className="w-8 h-8 flex items-center justify-center text-muted hover:text-white hover:bg-surface-hover rounded transition-colors text-sm font-mono font-bold"
          title="Zoom Out"
        >
          −
        </button>
        <button 
          onClick={() => fgRef.current?.zoomToFit(400, 40)}
          className="w-8 h-8 flex items-center justify-center text-muted hover:text-white hover:bg-surface-hover rounded transition-colors text-sm font-mono font-bold"
          title="Fit All"
        >
          ⊡
        </button>
        <button 
          onClick={() => setHullsVisible(v => !v)}
          className={`w-8 h-8 flex items-center justify-center rounded transition-colors text-lg ${hullsVisible ? 'text-accent text-[#7c3aed]' : 'text-muted hover:text-white hover:bg-surface-hover'}`}
          title={hullsVisible ? "Hide directory clusters" : "Show directory clusters"}
        >
          ⬡
        </button>
      </div>

      {/* Legend Overlay */}
      <div className="absolute bottom-4 right-4 z-10 bg-surface/80 backdrop-blur border border-border rounded-lg px-3 py-2 text-xs font-mono space-y-1.5 min-w-[140px]">
        <div className="flex items-center gap-2">
          <span className="w-2 h-2 rounded-full inline-block bg-[#3b82f6]"></span>
          <span className="text-muted">File</span>
        </div>
        <div className="flex items-center gap-2">
          <span className="w-2 h-2 rounded-full inline-block bg-[#7c3aed]"></span>
          <span className="text-muted">Function</span>
        </div>
        <div className="flex items-center gap-2">
          <span className="w-2 h-2 rounded-full inline-block bg-[#f59e0b]"></span>
          <span className="text-muted">Class</span>
        </div>
        <div className="flex items-center gap-2">
          <span className="w-2 h-2 rounded-full inline-block bg-[#22c55e]"></span>
          <span className="text-muted">Entry point</span>
        </div>
        
        {Object.keys(dirColorMap).length > 0 && (
          <>
            <div className="border-t border-border border-[#1e1e2e] mt-2 pt-2 mb-1">
              <span className="text-[10px] font-mono text-muted text-[#94a3b8] uppercase tracking-wider">CLUSTERS</span>
            </div>
            {Object.keys(dirColorMap).sort().slice(0, 8).map(dir => {
              const color = dirColorMap[dir];
              const isHidden = hiddenDirs.has(dir);
              return (
                <div 
                  key={dir} 
                  className={`flex items-center gap-2 py-0.5 cursor-pointer hover:opacity-80 transition-opacity ${isHidden ? 'opacity-40' : ''}`}
                  onClick={() => {
                    const next = new Set(hiddenDirs);
                    if (next.has(dir)) next.delete(dir);
                    else next.add(dir);
                    setHiddenDirs(next);
                  }}
                >
                  <span 
                    className="w-3 h-3 rounded-sm border flex-shrink-0"
                    style={{
                      backgroundColor: color.fill.replace("0.06", "0.4"),
                      borderColor: color.stroke.replace("0.35", "0.8").replace("0.30", "0.8")
                    }}
                  ></span>
                  <span className={`text-muted text-[#94a3b8] ${isHidden ? 'line-through' : ''}`}>
                    {dir === "__root__" ? "root files" : dir + "/"}
                  </span>
                  <span className="ml-auto text-[#94a3b8]">
                    {dirGroups[dir]?.length || 0} nodes
                  </span>
                </div>
              );
            })}
            {Object.keys(dirColorMap).length > 8 && (
              <div className="text-[10px] text-muted text-[#94a3b8] pt-1">
                + {Object.keys(dirColorMap).length - 8} more
              </div>
            )}
          </>
        )}
      </div>
      
      {/* Simulation Overlay Stats */}
      {simulationMode && blastRadius && (
        <div className="absolute bottom-0 left-0 right-0 h-10 bg-bg/90 backdrop-blur border-t border-border flex items-center justify-between px-6 z-20">
          <div className="text-xs font-mono text-white">
            Simulating changes to: {(() => {
              const srcEntry = [...blastRadius.affected.entries()].find(([_, d]) => d.severity === "source");
              const srcId = srcEntry ? srcEntry[0] : "unknown";
              const srcNode = graph?.nodes?.find(n => n.id === srcId);
              return srcNode?.label || srcId;
            })()}
          </div>
          
          <div className="flex items-center gap-3">
            <span className="text-red-400 font-mono text-xs">{blastRadius.stats.bySeverity.critical || 0} critical</span>
            <span className="text-orange-400 font-mono text-xs">{blastRadius.stats.bySeverity.high || 0} high</span>
            <span className="text-yellow-400 font-mono text-xs">{blastRadius.stats.bySeverity.medium || 0} medium</span>
            <span className="text-muted font-mono text-xs">{blastRadius.stats.total || 0} total affected</span>
          </div>
          
          <div 
            className="text-muted font-mono text-xs hover:text-white cursor-pointer"
            onClick={onExitSimulation}
          >
            Exit simulation ×
          </div>
        </div>
      )}
    </div>
  );
}
