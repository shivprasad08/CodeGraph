import { useRef, useState, useEffect, useMemo } from 'react';
import ForceGraph2D from 'react-force-graph-2d';

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
  zoomToNodes 
}) {
  const fgRef = useRef();
  const containerRef = useRef();
  
  const [dimensions, setDimensions] = useState({ width: 800, height: 600 });
  const [simulationDone, setSimulationDone] = useState(false);
  
  // Use refs for canvas render cycle to avoid re-renders on hover
  const hoveredNodeIdRef = useRef(null);
  const selectedNodeIdRef = useRef(selectedNodeId);
  const highlightedNodeIdsRef = useRef(highlightedNodeIds);
  const chatHighlightedNodeIdsRef = useRef(chatHighlightedNodeIds);

  // Sync refs
  useEffect(() => {
    highlightedNodeIdsRef.current = highlightedNodeIds;
  }, [highlightedNodeIds]);
  
  useEffect(() => {
    chatHighlightedNodeIdsRef.current = chatHighlightedNodeIds;
  }, [chatHighlightedNodeIds]);

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
      nodes: graph.nodes.map(n => ({
        ...n,
        val: computeNodeSize(n),
        color: computeNodeColor(n)
      })),
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
    if (fgRef.current) {
      fgRef.current.canvas.style.cursor = node ? "pointer" : "default";
    }
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
    if (isChatHighlighted) {
      ctx.beginPath();
      ctx.arc(node.x, node.y, size * 3, 0, 2 * Math.PI);
      ctx.strokeStyle = node.color + "80"; // 50% opacity border
      ctx.lineWidth = 2 / globalScale; // keep border crisp
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
        
        nodeCanvasObject={nodeCanvasObject}
        nodeCanvasObjectMode={() => "replace"}
        nodeLabel={node => ""}
        
        linkColor={link => {
          if (highlightedNodeIds.size === 0) return link.color;
          const srcId = typeof link.source === 'object' ? link.source.id : link.source;
          const tgtId = typeof link.target === 'object' ? link.target.id : link.target;
          return (highlightedNodeIds.has(srcId) || highlightedNodeIds.has(tgtId)) 
            ? link.color 
            : "rgba(255,255,255,0.03)";
        }}
        linkWidth={link => link.width}
        linkDirectionalArrowLength={link => link.type === "calls" ? 4 : 0}
        linkDirectionalArrowRelPos={1}
        linkDirectionalParticles={
          hasManyNodes ? 0 : (link => link.type === "calls" ? 2 : 0)
        }
        linkDirectionalParticleSpeed={0.004}
        linkDirectionalParticleColor={link => {
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
      </div>

      {/* Legend Overlay */}
      <div className="absolute bottom-4 right-4 z-10 bg-surface/80 backdrop-blur border border-border rounded-lg px-3 py-2 text-xs font-mono space-y-1.5">
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
      </div>
    </div>
  );
}
