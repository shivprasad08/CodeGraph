import { useState, useEffect, useRef } from 'react';
import { streamImpactAnalysis } from '../api';
import { computeBlastRadius, detectBrokenPipelines } from '../utils/blastRadius';

export default function SimulatorPanel({
  graph,
  jobId,
  onBlastRadiusChange,
  onSimulationModeChange,
  onNodeHighlight,
  onNodeNavigate,
  simulationSourceFile
}) {
  const [searchTerm, setSearchTerm] = useState('');
  const [selectedNode, setSelectedNode] = useState(null);
  const [changeDescription, setChangeDescription] = useState('');
  
  const [isSimulating, setIsSimulating] = useState(false);
  const [simulationResultVisible, setSimulationResultVisible] = useState(false);
  const [isLoadingLLM, setIsLoadingLLM] = useState(false);
  const [llmResponse, setLLMResponse] = useState('');
  const [riskLevel, setRiskLevel] = useState(null); // SAFE, CAUTION, RISKY, DANGEROUS
  
  const [blastResult, setBlastResult] = useState(null);
  const [brokenPipelines, setBrokenPipelines] = useState([]);
  
  const responseEndRef = useRef(null);
  
  // Auto-select node if passed from context menu
  useEffect(() => {
    if (simulationSourceFile && graph?.nodes) {
      const node = graph.nodes.find(n => n.id === simulationSourceFile);
      if (node) setSelectedNode(node);
    }
  }, [simulationSourceFile, graph]);

  useEffect(() => {
    if (isLoadingLLM) {
      responseEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
  }, [llmResponse, isLoadingLLM]);

  const handleSelectSource = (node) => {
    setSelectedNode(node);
    setSearchTerm('');
    // Highlight it in graph temporarily
    if (onNodeHighlight) onNodeHighlight([node.id]);
  };

  const handleClearSelection = () => {
    setSelectedNode(null);
    if (simulationResultVisible) handleExitSimulation();
  };

  const runSimulation = () => {
    if (!selectedNode || !graph) return;
    
    setIsSimulating(true);
    setLLMResponse('');
    setRiskLevel(null);
    
    // 1. Client-side blast radius
    const blastRes = computeBlastRadius(graph, [selectedNode.id]);
    
    // 2. Client-side pipeline break detection
    const pipelines = detectBrokenPipelines(graph, new Set(blastRes.affected.keys()));
    
    setBlastResult(blastRes);
    setBrokenPipelines(pipelines);
    
    // Update parent
    if (onBlastRadiusChange) onBlastRadiusChange(blastRes);
    if (onSimulationModeChange) onSimulationModeChange(true);
    
    setSimulationResultVisible(true);
    setIsLoadingLLM(true);
    setIsSimulating(false);
    
    // 3. Backend impact analysis stream
    streamImpactAnalysis(
      jobId,
      selectedNode.id,
      changeDescription,
      {
        affected_count: blastRes.stats.total,
        critical_nodes: [...blastRes.affected.entries()]
          .filter(([_, d]) => d.severity === "critical")
          .map(([id]) => id),
        broken_pipelines: pipelines.map(p => ({
          entry_point: p.entryPoint.id,
          risk: p.risk
        }))
      },
      (token) => {
        setLLMResponse(prev => prev + token);
      },
      ({ riskLevel, nodes }) => {
        setRiskLevel(riskLevel);
        setIsLoadingLLM(false);
      },
      (err) => {
        setLLMResponse(prev => prev + `\n\nError: ${err}`);
        setIsLoadingLLM(false);
      }
    );
  };

  const handleExitSimulation = () => {
    if (onSimulationModeChange) onSimulationModeChange(false);
    if (onBlastRadiusChange) onBlastRadiusChange(null);
    setSimulationResultVisible(false);
    setBlastResult(null);
    setLLMResponse('');
    setRiskLevel(null);
  };

  // Search results
  const searchResults = searchTerm && graph?.nodes 
    ? graph.nodes.filter(n => 
        n.label.toLowerCase().includes(searchTerm.toLowerCase()) || 
        (n.file && n.file.toLowerCase().includes(searchTerm.toLowerCase()))
      ).slice(0, 10)
    : [];

  // Parse inline `node::id` references
  const renderLLMText = (text) => {
    const parts = text.split(/`([^`]+)`/g);
    return parts.map((part, i) => {
      if (i % 2 === 1) {
        // Is this a node reference? Check if it exists in graph
        const nodeExists = graph?.nodes?.some(n => n.id === part || n.label === part);
        if (nodeExists) {
          return (
            <span 
              key={i} 
              className="text-purple-400 font-mono bg-purple-500/10 px-1 rounded cursor-pointer hover:bg-purple-500/20 transition-colors"
              onClick={() => {
                const targetNode = graph.nodes.find(n => n.id === part || n.label === part);
                if (targetNode) {
                  if (onNodeHighlight) onNodeHighlight([targetNode.id]);
                  if (onNodeNavigate) onNodeNavigate(targetNode);
                }
              }}
            >
              {part}
            </span>
          );
        }
        return <code key={i} className="bg-surface-hover px-1 rounded text-[#eab308] font-mono">{part}</code>;
      }
      return <span key={i}>{part}</span>;
    });
  };

  return (
    <div className="flex flex-col h-full overflow-hidden bg-bg">
      {/* Section 1: Node Selector */}
      <div className="flex-shrink-0">
        <div className="text-[10px] font-mono text-muted uppercase tracking-wider mx-3 mt-3 mb-2">
          Select a file or function to simulate changes
        </div>
        
        {!selectedNode ? (
          <div className="relative mx-3">
            <input
              type="text"
              value={searchTerm}
              onChange={e => setSearchTerm(e.target.value)}
              placeholder="Search files or functions..."
              className="w-full bg-surface border border-border rounded-lg px-3 py-2 font-mono text-xs text-white placeholder:text-muted focus:border-accent outline-none"
            />
            {searchResults.length > 0 && (
              <div className="absolute top-full left-0 right-0 mt-1 max-h-48 overflow-y-auto bg-surface border border-border rounded-lg shadow-xl z-20">
                {searchResults.map(n => (
                  <div
                    key={n.id}
                    onClick={() => handleSelectSource(n)}
                    className="py-2 px-3 flex items-center gap-2 cursor-pointer hover:bg-surface-hover transition-colors"
                  >
                    <div className={`w-2 h-2 rounded-full ${
                      n.type === 'file' ? 'bg-blue-500' :
                      n.type === 'class' ? 'bg-yellow-500' : 'bg-purple-500'
                    }`} />
                    <div className="font-mono text-xs text-white truncate">{n.label}</div>
                    <div className="text-[10px] text-muted truncate ml-auto max-w-[100px]">{n.file}</div>
                  </div>
                ))}
              </div>
            )}
          </div>
        ) : (
          <div className="mx-3 bg-surface border border-border rounded-lg px-3 py-2.5 flex items-center gap-2">
            <div className={`w-2.5 h-2.5 rounded-full ${
              selectedNode.type === 'file' ? 'bg-blue-500' :
              selectedNode.type === 'class' ? 'bg-yellow-500' : 'bg-purple-500'
            }`} />
            <div className="overflow-hidden">
              <div className="font-mono text-sm text-white font-medium truncate">{selectedNode.label}</div>
              <div className="text-[10px] text-muted mt-0.5 font-mono truncate">{selectedNode.file}</div>
            </div>
            <button 
              onClick={handleClearSelection}
              className="ml-auto text-muted hover:text-white px-2 text-lg leading-none"
            >
              ×
            </button>
          </div>
        )}
      </div>

      {/* Section 2: Change description */}
      <div className="flex-shrink-0">
        <div className="text-[10px] font-mono text-muted uppercase tracking-wider mx-3 mt-4 mb-2">
          Describe your change (optional)
        </div>
        <textarea
          value={changeDescription}
          onChange={e => setChangeDescription(e.target.value)}
          placeholder="e.g. Change token expiry from 24h to 1h, add extra validation step, rename this function..."
          className="w-[calc(100%-1.5rem)] mx-3 bg-surface border border-border rounded-xl px-3 py-2.5 font-mono text-xs text-white placeholder:text-muted focus:border-accent outline-none resize-none"
          rows={3}
        />
        <div className="mx-3 mt-2 flex flex-wrap gap-1.5">
          {["Change the logic", "Rename this", "Add a parameter", "Remove this function"].map(suggestion => (
            <div 
              key={suggestion}
              onClick={() => setChangeDescription(suggestion)}
              className="bg-surface border border-border rounded-full px-2 py-0.5 text-[10px] font-mono text-muted hover:text-white hover:border-accent/40 cursor-pointer transition-all"
            >
              {suggestion}
            </div>
          ))}
        </div>
      </div>

      {/* Section 3: Run Button */}
      <div className="mx-3 mt-4 flex-shrink-0 mb-2">
        <button
          onClick={runSimulation}
          disabled={!selectedNode || isSimulating || isLoadingLLM}
          className="w-full bg-accent hover:bg-accent-light text-white font-mono text-sm py-2.5 rounded-xl font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
        >
          {isSimulating || isLoadingLLM ? (
            <>
              <div className="w-3 h-3 border-2 border-white/30 border-t-white rounded-full animate-spin" />
              Simulating...
            </>
          ) : (
            "⚡ Run Simulation"
          )}
        </button>
      </div>

      {/* Section 4: Simulation Results */}
      {simulationResultVisible && blastResult && (
        <div className="flex-1 overflow-y-auto pb-4">
          
          {/* 4a. Risk level banner */}
          <div className={`mx-3 mt-2 rounded-xl border px-4 py-3 flex items-center gap-3 ${
            !riskLevel ? 'bg-surface border-border animate-pulse' :
            riskLevel === 'SAFE' ? 'bg-green-500/15 border-green-500/40 text-green-400' :
            riskLevel === 'CAUTION' ? 'bg-yellow-500/15 border-yellow-500/40 text-yellow-400' :
            riskLevel === 'RISKY' ? 'bg-orange-500/15 border-orange-500/40 text-orange-400' :
            'bg-red-500/15 border-red-500/40 text-red-400'
          }`}>
            <div className="text-2xl flex-shrink-0">
              {!riskLevel ? "⚡" :
               riskLevel === 'SAFE' ? "✓" :
               riskLevel === 'CAUTION' ? "⚠" :
               riskLevel === 'RISKY' ? "⚡" : "🔴"}
            </div>
            <div>
              <div className="font-mono font-bold text-sm">
                {!riskLevel ? "ANALYZING IMPACT..." : riskLevel}
              </div>
              <div className="text-[10px] opacity-70 mt-0.5 uppercase tracking-wide">
                {!riskLevel ? "Scanning relationships" :
                 riskLevel === 'SAFE' ? "Change appears low-risk" :
                 riskLevel === 'CAUTION' ? "Review affected components" :
                 riskLevel === 'RISKY' ? "Significant cascade possible" :
                 "High risk of breaking changes"}
              </div>
            </div>
          </div>

          {/* 4b. Impact stats row */}
          <div className="mx-3 mt-3 grid grid-cols-3 gap-2">
            <div className="bg-surface border border-border rounded-lg p-2 text-center">
              <div className="text-white font-mono font-bold text-lg leading-tight">{blastResult.stats.total}</div>
              <div className="text-muted font-mono text-[10px] uppercase">Affected</div>
            </div>
            <div className="bg-red-500/10 border border-red-500/20 rounded-lg p-2 text-center">
              <div className="text-red-400 font-mono font-bold text-lg leading-tight">{blastResult.stats.bySeverity.critical || 0}</div>
              <div className="text-red-400/70 font-mono text-[10px] uppercase">Direct</div>
            </div>
            <div className="bg-orange-500/10 border border-orange-500/20 rounded-lg p-2 text-center">
              <div className="text-orange-400 font-mono font-bold text-lg leading-tight">{brokenPipelines.length}</div>
              <div className="text-orange-400/70 font-mono text-[10px] uppercase tracking-tighter">Pipelines</div>
            </div>
          </div>

          {/* 4c. Blast path visualization */}
          <div className="mx-3 mt-4">
            <div className="text-[10px] font-mono text-muted uppercase tracking-wider mb-2">Impact Cascade</div>
            <div className="bg-surface/50 border border-border rounded-lg p-3 overflow-hidden text-xs font-mono space-y-1.5">
              
              {/* Depth 0 */}
              <div className="text-white flex items-center gap-1.5 font-medium truncate">
                <span className="text-[8px]">⬤</span> {selectedNode.label}
              </div>
              
              {/* Depth 1 */}
              {(() => {
                const crit = [...blastResult.affected.entries()].filter(([_, d]) => d.severity === 'critical');
                return crit.slice(0, 4).map(([id, d], i) => {
                  const node = graph?.nodes?.find(n => n.id === id);
                  return (
                    <div 
                      key={id} 
                      className="text-red-400 flex items-center gap-1.5 truncate cursor-pointer hover:opacity-80 ml-3"
                      onClick={() => {
                        if (node && onNodeNavigate) onNodeNavigate(node);
                      }}
                    >
                      <span className="text-muted">└─</span> <span className="text-[8px]">⬤</span> {node?.label || id}
                    </div>
                  );
                }).concat(crit.length > 4 ? [
                  <div key="crit-more" className="text-muted ml-3 pl-5 text-[10px]">
                    + {crit.length - 4} more direct deps...
                  </div>
                ] : []);
              })()}
              
              {/* Depth 2 */}
              {(() => {
                const high = [...blastResult.affected.entries()].filter(([_, d]) => d.severity === 'high');
                if (high.length === 0) return null;
                return high.slice(0, 3).map(([id, d], i) => {
                  const node = graph?.nodes?.find(n => n.id === id);
                  return (
                    <div 
                      key={id} 
                      className="text-orange-400 flex items-center gap-1.5 truncate cursor-pointer hover:opacity-80 ml-6"
                      onClick={() => {
                        if (node && onNodeNavigate) onNodeNavigate(node);
                      }}
                    >
                      <span className="text-muted">└─</span> <span className="text-[8px]">⬤</span> {node?.label || id}
                    </div>
                  );
                }).concat(high.length > 3 ? [
                  <div key="high-more" className="text-muted ml-6 pl-5 text-[10px]">
                    + {high.length - 3} more secondary deps...
                  </div>
                ] : []);
              })()}
              
              {/* Depth 3+ */}
              {(() => {
                const others = [...blastResult.affected.entries()].filter(([_, d]) => d.depth >= 3);
                if (others.length === 0) return null;
                return (
                  <div className="text-muted flex items-center gap-1.5 truncate ml-6">
                    <span className="text-muted">└─</span> {others.length} more transitive dependencies
                  </div>
                );
              })()}
            </div>
          </div>

          {/* 4d. Broken pipelines */}
          {brokenPipelines.length > 0 && (
            <div className="mx-3 mt-4">
              <div className="text-[10px] font-mono text-muted uppercase tracking-wider mb-2">Pipelines at Risk</div>
              {brokenPipelines.map((p, i) => (
                <div key={i} className={`mb-2 rounded-lg border px-3 py-2 cursor-pointer transition-colors ${
                  p.risk === 'high' ? 'border-red-500/30 bg-red-500/8 hover:bg-red-500/15' : 'border-yellow-500/30 bg-yellow-500/8 hover:bg-yellow-500/15'
                }`}
                  onClick={() => {
                    if (onNodeNavigate) onNodeNavigate(p.entryPoint);
                  }}
                >
                  <div className="font-mono text-xs font-medium text-white truncate">{p.entryPoint.label}</div>
                  <div className="text-[10px] text-muted mt-0.5">
                    {p.affectedInPath.length} affected node(s) along path
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* 4e. LLM analysis text */}
          <div className="mx-3 mt-4 mb-2">
            <div className="text-[10px] font-mono text-muted uppercase tracking-wider mb-2">AI Impact Analysis</div>
            <div className="bg-surface border border-border rounded-xl px-3 py-3 font-sans text-xs text-white/80 leading-relaxed whitespace-pre-wrap min-h-[100px]">
              {renderLLMText(llmResponse)}
              {isLoadingLLM && (
                <span className="inline-block w-1.5 h-3 bg-white/70 ml-1 animate-pulse align-middle" />
              )}
              <div ref={responseEndRef} />
            </div>
          </div>

          {/* 4f. Action buttons */}
          <div className="mx-3 mt-4 mb-6 space-y-2">
            <button
              onClick={() => {
                // Focus the first critical node in inspector if possible, or source node
                const firstCrit = [...blastResult.affected.entries()].find(([_, d]) => d.severity === 'critical')?.[0];
                const targetNode = graph?.nodes?.find(n => n.id === (firstCrit || selectedNode.id));
                if (targetNode && onNodeNavigate) onNodeNavigate(targetNode);
              }}
              className="w-full bg-surface border border-border hover:bg-surface-hover rounded-lg py-2 font-mono text-xs text-white text-center transition-colors"
            >
              View affected code
            </button>
            <button
              onClick={handleExitSimulation}
              className="w-full text-muted hover:text-white font-mono text-[10px] uppercase tracking-wider text-center py-2 transition-colors"
            >
              Exit simulation ×
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
