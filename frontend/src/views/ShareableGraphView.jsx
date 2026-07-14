import { useState, useEffect, useMemo } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { fetchRepo, fetchGraph, subscribeToJob, fetchAnalysis } from '../api';
import ProgressBar from '../components/ProgressBar';
import GraphCanvas from '../components/GraphCanvas';
import NodePanel from '../components/NodePanel';
import { buildDirectoryColorMap } from '../utils/directoryColors';

import FileTree from '../components/FileTree';
import CodeInspector from '../components/CodeInspector';
import HealthPanel from '../components/HealthPanel';

export default function ShareableGraphView() {
  const { owner, repo, jobId } = useParams();
  const navigate = useNavigate();
  
  const [graphData, setGraphData] = useState(null);
  const [analysis, setAnalysis] = useState(null);
  const [analysisLoading, setAnalysisLoading] = useState(false);
  const [jobStatus, setJobStatus] = useState(null); // 'analyzing', 'error'
  const [error, setError] = useState(null);
  const [selectedNode, setSelectedNode] = useState(null);
  
  // Compute directory colors globally for graph and file tree
  const dirColorMap = useMemo(
    () => (graphData ? buildDirectoryColorMap(graphData.nodes) : {}),
    [graphData]
  );
  
  // New layout and file tree states
  const [selectedFilePath, setSelectedFilePath] = useState(null);
  const [highlightedNodeIds, setHighlightedNodeIds] = useState(new Set());
  const [zoomToNodes, setZoomToNodes] = useState(null);
  const [sidebarVisible, setSidebarVisible] = useState(window.innerWidth >= 768);
  const [chatVisible, setChatVisible] = useState(window.innerWidth >= 768);

  // Inspector state
  const [inspectorFilePath, setInspectorFilePath] = useState(null);
  const [inspectorVisible, setInspectorVisible] = useState(false);

  const [chatHighlightedNodeIds, setChatHighlightedNodeIds] = useState(new Set());

  // Simulation state
  const [simulationMode, setSimulationMode] = useState(false);
  const [blastRadius, setBlastRadius] = useState(null);
  const [simulationSourceFile, setSimulationSourceFile] = useState(null);

  // Progress state for loading UI
  const [progress, setProgress] = useState(0);
  const [stage, setStage] = useState('queued');
  const [message, setMessage] = useState('Queued');
  const [startedAt, setStartedAt] = useState(null);
  
  // Share button state
  const [copied, setCopied] = useState(false);
  const [isCached, setIsCached] = useState(false);

  // Global Keyboard Shortcuts
  useEffect(() => {
    const handleGlobalKeyDown = (e) => {
      if (e.key === 'Escape') {
        // Clear in priority order
        if (simulationMode) {
          setSimulationMode(false);
          setBlastRadius(null);
        } else if (document.activeElement?.id === 'file-tree-search') {
          document.activeElement.blur();
        } else if (inspectorVisible) {
          setInspectorVisible(false);
        } else if (selectedFilePath) {
          setSelectedFilePath(null);
          setHighlightedNodeIds(new Set());
          setZoomToNodes(null);
        } else if (selectedNode) {
          setSelectedNode(null);
        }
      } else if ((e.ctrlKey || e.metaKey) && e.key === 'b') {
        e.preventDefault();
        setSidebarVisible(v => !v);
      } else if ((e.ctrlKey || e.metaKey) && e.key === 'j') {
        e.preventDefault();
        setChatVisible(v => !v);
      } else if ((e.ctrlKey || e.metaKey) && e.key === 'w') {
        e.preventDefault();
        setInspectorVisible(false);
      } else if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === 'e') {
        e.preventDefault();
        setInspectorVisible(v => !v);
      }
    };
    
    document.addEventListener('keydown', handleGlobalKeyDown);
    return () => document.removeEventListener('keydown', handleGlobalKeyDown);
  }, [selectedFilePath, selectedNode, inspectorVisible, simulationMode]);

  useEffect(() => {
    // Set basic title immediately
    document.title = `CodeGraph — ${owner}/${repo}`;
    
    if (jobId) {
      // Flow B: we have a jobId, subscribe to SSE
      setJobStatus('analyzing');
      setStartedAt(Date.now());
      
      const unsubscribe = subscribeToJob(
        jobId,
        (data) => {
          setProgress(data.progress);
          setStage(data.stage);
          setMessage(data.message);
        },
        (errMsg) => {
          setError(errMsg);
          setJobStatus('error');
        },
        async () => {
          // done
          try {
            const finalGraph = await fetchGraph(jobId);
            setGraphData(finalGraph);
            setJobStatus('done');
            
            if (finalGraph.analysis) {
              setAnalysis(finalGraph.analysis);
            } else {
              setAnalysisLoading(true);
              fetchAnalysis(jobId).then(data => {
                setAnalysis(data);
                setAnalysisLoading(false);
              }).catch(() => setAnalysisLoading(false));
            }
          } catch (err) {
            setError(err.message || "Failed to load graph after completion");
            setJobStatus('error');
          }
        }
      );
      return unsubscribe;
    } else {
      // Flow A: Check if cached or trigger analysis
      const loadRepo = async () => {
        try {
          const res = await fetchRepo(owner, repo);
          if (res.status === 'cached') {
            setIsCached(true);
            setGraphData(res.graph);
            setJobStatus('done');
            
            if (res.graph.analysis) {
              setAnalysis(res.graph.analysis);
            } else if (jobId) {
              setAnalysisLoading(true);
              fetchAnalysis(jobId).then(data => {
                setAnalysis(data);
                setAnalysisLoading(false);
              }).catch(() => setAnalysisLoading(false));
            }
          } else if (res.status === 'analyzing') {
            // Redirect to the job URL to watch progress
            navigate(`/graph/${owner}/${repo}/jobs/${res.job_id}`, { replace: true });
          }
        } catch (err) {
          setError(err.message || `Could not analyze ${owner}/${repo}`);
          setJobStatus('error');
        }
      };
      loadRepo();
    }
  }, [owner, repo, jobId, navigate]);

  const handleShare = () => {
    const shareUrl = `${window.location.origin}/graph/${owner}/${repo}`;
    navigator.clipboard.writeText(shareUrl);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const effectiveHighlights = new Set([...highlightedNodeIds, ...chatHighlightedNodeIds]);

  const handleChatHighlight = (nodeIds) => {
    setChatHighlightedNodeIds(new Set(nodeIds));
    setZoomToNodes([...nodeIds]);
    setTimeout(() => {
      setChatHighlightedNodeIds(new Set());
    }, 5000);
  };

  const handleFileSelect = (filePath) => {
    if (selectedFilePath === filePath) {
      if (!inspectorVisible) {
        setInspectorVisible(true);
        setInspectorFilePath(filePath);
      } else {
        setSelectedFilePath(null);
        setHighlightedNodeIds(new Set());
        setZoomToNodes(null);
        setInspectorVisible(false);
      }
      if (window.innerWidth < 768) setSidebarVisible(false); // Close on select for mobile
      return;
    }
    
    setSelectedFilePath(filePath);
    setInspectorFilePath(filePath);
    setInspectorVisible(true);
    if (window.innerWidth < 768) setSidebarVisible(false); // Close on select for mobile
    
    if (!graphData) return;
    const fileNodeIds = new Set(
      graphData.nodes
        .filter(n => n.file === filePath || n.id === filePath)
        .map(n => n.id)
    );
    setHighlightedNodeIds(fileNodeIds);
    setZoomToNodes([...fileNodeIds]);
  };

  const handleSimulateFile = (filePath) => {
    setSimulationSourceFile(filePath);
  };

  const handleNodeNavigate = (node) => {
    if (!node) {
      setSelectedNode(null);
      setHighlightedNodeIds(new Set());
      setSelectedFilePath(null);
      return;
    }
    setSelectedNode(node);
    setHighlightedNodeIds(new Set([node.id]));
    
    if (node.type === "function" || node.type === "class" || node.type === "file") {
      if (inspectorVisible && inspectorFilePath !== node.file) {
        setInspectorFilePath(node.file);
      }
    }
  };

  if (error) {
    return (
      <div className="h-screen bg-[#0a0a0f] text-white flex flex-col items-center justify-center p-4 font-sans">
        <div className="bg-[#111118] border border-[#1e1e2e] rounded-xl p-8 max-w-md w-full text-center shadow-2xl">
          <div className="text-4xl mb-4">⚠️</div>
          <h2 className="text-xl font-semibold mb-2">Could not analyze {owner}/{repo}</h2>
          <p className="text-[#94a3b8] mb-8">{error}</p>
          <button 
            onClick={() => navigate('/')}
            className="bg-[#1e1e2e] hover:bg-[#2a2a3b] text-white px-6 py-2.5 rounded-lg transition"
          >
            Back to home
          </button>
        </div>
      </div>
    );
  }

  if (jobStatus === 'analyzing' || (!graphData && jobStatus !== 'error')) {
    return (
      <div className="h-screen bg-[#0a0a0f] flex items-center justify-center p-4">
        <ProgressBar 
          progress={progress} 
          stage={stage} 
          message={message} 
          startedAt={startedAt} 
        />
      </div>
    );
  }

  // Loaded graph view
  return (
    <div className="h-screen w-full flex overflow-hidden bg-[#0a0a0f] font-sans">
      
      {/* Left Sidebar - File Tree */}
      <FileTree
        graph={graphData}
        onFileSelect={handleFileSelect}
        onNodeSelect={handleNodeNavigate}
        onSimulateFile={handleSimulateFile}
        selectedFilePath={selectedFilePath}
        selectedNodeId={selectedNode?.id ?? null}
        hidden={!sidebarVisible}
        onClose={() => setSidebarVisible(false)}
        dirColorMap={dirColorMap}
      />

      {/* Center - Graph Canvas */}
      <div className="flex-1 relative overflow-hidden flex flex-col min-w-[300px]">
        <GraphCanvas 
          graph={graphData} 
          onNodeClick={handleNodeNavigate} 
          selectedNodeId={selectedNode?.id ?? null}
          highlightedNodeIds={effectiveHighlights}
          chatHighlightedNodeIds={chatHighlightedNodeIds}
          zoomToNodes={zoomToNodes}
          dirColorMap={dirColorMap}
          blastRadius={blastRadius}
          simulationMode={simulationMode}
          onExitSimulation={() => {
            setSimulationMode(false);
            setBlastRadius(null);
          }}
        />
        
        {/* Top Overlay */}
        {simulationMode && (
          <div className="absolute top-12 left-1/2 -translate-x-1/2 z-30 bg-red-500/20 border border-red-500/40 rounded-full px-4 py-1.5 flex items-center gap-2 pointer-events-none">
            <div className="w-2 h-2 rounded-full bg-red-500 animate-pulse"></div>
            <div className="text-red-400 font-mono text-xs">SIMULATION ACTIVE — graph shows blast radius</div>
          </div>
        )}
        <div className="absolute top-4 left-4 right-4 flex justify-between items-start pointer-events-none z-10">
          
          {/* Left Stats Pill - Hidden on very small screens */}
          <div className="hidden md:block bg-[#111118]/80 backdrop-blur border border-[#1e1e2e]/40 rounded-xl p-4 min-w-[200px] pointer-events-auto shadow-lg">
            <div className="text-xs text-[#94a3b8] mb-1 font-mono uppercase tracking-wider flex items-center gap-2">
              Repository
              {isCached && <span className="bg-[#7c3aed]/20 text-[#7c3aed] px-1.5 py-0.5 rounded text-[10px]">CACHED</span>}
            </div>
            <a 
              href={`https://github.com/${owner}/${repo}`}
              target="_blank"
              rel="noopener noreferrer"
              className="text-white font-medium hover:text-[#7c3aed] transition flex items-center gap-1 group"
            >
              {owner}/{repo}
              <span className="text-[#94a3b8] group-hover:text-[#7c3aed] text-xs transition">↗</span>
            </a>
            <div className="mt-3 flex gap-4 text-sm">
              <div>
                <div className="text-[#94a3b8] text-xs">Nodes</div>
                <div className="text-white font-mono">{graphData.nodes.length}</div>
              </div>
              <div>
                <div className="text-[#94a3b8] text-xs">Edges</div>
                <div className="text-white font-mono">{graphData.edges.length}</div>
              </div>
            </div>
          </div>
          
          {/* Mobile specific top pill */}
          <div className="md:hidden bg-[#111118]/80 backdrop-blur border border-[#1e1e2e]/40 rounded-full px-3 py-1.5 pointer-events-auto shadow-lg flex items-center gap-2">
            <span className="text-white text-xs font-mono font-medium truncate max-w-[120px]">{repo}</span>
            {isCached && <span className="bg-[#7c3aed]/20 text-[#7c3aed] px-1 py-0.5 rounded text-[9px]">CACHED</span>}
          </div>

          {/* Right Action Buttons */}
          <div className="flex gap-2 pointer-events-auto items-center">
            <button
              onClick={handleShare}
              className="bg-[#111118]/80 backdrop-blur border border-[#7c3aed]/40 rounded-full px-3 md:px-4 py-1.5 text-[10px] md:text-xs font-mono text-[#7c3aed] hover:bg-[#7c3aed]/10 transition flex items-center gap-1.5 shadow-lg"
            >
              {copied ? 'Copied!' : 'Share'}
            </button>
            <button
              onClick={() => navigate('/')}
              className="bg-[#111118]/80 backdrop-blur border border-[#1e1e2e]/40 rounded-full px-3 md:px-4 py-1.5 text-[10px] md:text-xs font-mono text-white hover:bg-[#1e1e2e] transition shadow-lg"
            >
              New
            </button>
          </div>
        </div>

        <NodePanel 
          node={selectedNode} 
          graph={graphData} 
          onClose={() => setSelectedNode(null)} 
        />

        {inspectorVisible && (
          <CodeInspector
            filePath={inspectorFilePath}
            graph={graphData}
            selectedNodeId={selectedNode?.id ?? null}
            onClose={() => setInspectorVisible(false)}
            onNodeClick={handleNodeNavigate}
            onFileSelect={handleFileSelect}
            repo={owner + '/' + repo}
            commitSha={graphData?.commit_sha}
          />
        )}

        {/* Mobile Floating Action Buttons for Drawers */}
        <div className="md:hidden absolute bottom-6 left-1/2 -translate-x-1/2 flex items-center gap-2 z-30 pointer-events-auto bg-[#111118]/90 backdrop-blur p-1.5 rounded-full border border-[#1e1e2e]/50 shadow-2xl">
          <button 
            onClick={() => setSidebarVisible(true)}
            className="px-4 py-2 rounded-full text-xs font-mono font-medium text-white hover:bg-[#1e1e2e] transition-colors"
          >
            ≡ Files
          </button>
          <div className="w-px h-6 bg-[#1e1e2e]/50" />
          <button 
            onClick={() => setChatVisible(true)}
            className="px-4 py-2 rounded-full text-xs font-mono font-medium text-white hover:bg-[#1e1e2e] transition-colors"
          >
            ✦ AI Chat
          </button>
        </div>
      </div>
      
      {/* Right Sidebar - Health & Chat */}
      <HealthPanel
        analysis={analysis}
        graph={graphData}
        jobId={jobId}
        onNodeClick={handleNodeNavigate}
        onNodeHighlight={(ids) => setChatHighlightedNodeIds(new Set(ids))}
        isLoading={analysisLoading}
        onBlastRadiusChange={setBlastRadius}
        onSimulationModeChange={setSimulationMode}
        simulationSourceFile={simulationSourceFile}
        hidden={!chatVisible}
        onClose={() => setChatVisible(false)}
      />
    </div>
  );
}
