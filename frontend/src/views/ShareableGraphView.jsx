import { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { fetchRepo, fetchGraph, subscribeToJob } from '../api';
import ProgressBar from '../components/ProgressBar';
import GraphCanvas from '../components/GraphCanvas';
import NodePanel from '../components/NodePanel';

export default function ShareableGraphView() {
  const { owner, repo, jobId } = useParams();
  const navigate = useNavigate();
  
  const [graphData, setGraphData] = useState(null);
  const [jobStatus, setJobStatus] = useState(null); // 'analyzing', 'error'
  const [error, setError] = useState(null);
  const [selectedNode, setSelectedNode] = useState(null);
  
  // Progress state for loading UI
  const [progress, setProgress] = useState(0);
  const [stage, setStage] = useState('queued');
  const [message, setMessage] = useState('Queued');
  const [startedAt, setStartedAt] = useState(null);
  
  // Share button state
  const [copied, setCopied] = useState(false);
  const [isCached, setIsCached] = useState(false);

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
    <div className="h-screen w-full relative bg-[#0a0a0f] overflow-hidden font-sans">
      <GraphCanvas 
        graph={graphData} 
        onNodeClick={setSelectedNode} 
      />
      
      {/* Top Overlay */}
      <div className="absolute top-4 left-4 right-4 flex justify-between items-start pointer-events-none">
        
        {/* Left Stats Pill */}
        <div className="bg-[#111118]/80 backdrop-blur border border-[#1e1e2e]/40 rounded-xl p-4 min-w-[200px] pointer-events-auto">
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

        {/* Right Action Buttons */}
        <div className="flex gap-2 pointer-events-auto">
          <button
            onClick={handleShare}
            className="bg-[#111118]/80 backdrop-blur border border-[#7c3aed]/40 rounded-full px-4 py-1.5 text-xs font-mono text-[#7c3aed] hover:bg-[#7c3aed]/10 transition flex items-center gap-1.5"
          >
            {copied ? 'Copied!' : 'Share'}
          </button>
          <button
            onClick={() => navigate('/')}
            className="bg-[#111118]/80 backdrop-blur border border-[#1e1e2e]/40 rounded-full px-4 py-1.5 text-xs font-mono text-white hover:bg-[#1e1e2e] transition"
          >
            New repo
          </button>
        </div>
      </div>

      <NodePanel 
        node={selectedNode} 
        graph={graphData} 
        onClose={() => setSelectedNode(null)} 
      />
    </div>
  );
}
