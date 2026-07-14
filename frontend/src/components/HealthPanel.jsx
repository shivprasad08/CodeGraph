import { useState, useMemo, useEffect } from 'react';
import ChatSidebar from './ChatSidebar';
import SimulatorPanel from './SimulatorPanel';

export default function HealthPanel({
  analysis,
  graph,
  jobId,
  onNodeClick,
  onNodeHighlight,
  isLoading,
  onBlastRadiusChange,
  onSimulationModeChange,
  simulationSourceFile,
  hidden,
  onClose
}) {
  const [activeTab, setActiveTab] = useState('health'); // 'health', 'chat', or 'simulate'
  const [activeFilter, setActiveFilter] = useState('All'); // 'All', 'high', 'medium', 'low'

  useEffect(() => {
    if (simulationSourceFile) {
      setActiveTab('simulate');
    }
  }, [simulationSourceFile]);

  const handleRefresh = () => {
    // We could pass an onRefresh callback to force reload,
    // but the instruction says: "refresh button: onClick: re-fetch analysis".
    // We can emit a custom event or let App.jsx handle it.
    // For now, we'll reload the page if onRefresh is not provided, 
    // or better, dispatch an event.
    window.location.reload();
  };

  // Calculate Issue Counts
  const highCount = analysis?.issues?.filter(i => i.severity === 'high').length || 0;
  const mediumCount = analysis?.issues?.filter(i => i.severity === 'medium').length || 0;
  const lowCount = analysis?.issues?.filter(i => i.severity === 'low').length || 0;

  // Group issues by file
  const groupedIssues = useMemo(() => {
    if (!analysis?.issues) return [];
    const grouped = {};
    for (const issue of analysis.issues) {
      if (!grouped[issue.file]) {
        grouped[issue.file] = {
          file: issue.file,
          severity: issue.severity, // initial
          issues: []
        };
      }
      grouped[issue.file].issues.push(issue);
      // Determine worst severity
      const ranks = { high: 3, medium: 2, low: 1, info: 0 };
      if (ranks[issue.severity] > ranks[grouped[issue.file].severity]) {
        grouped[issue.file].severity = issue.severity;
      }
    }
    
    return Object.values(grouped).sort((a, b) => {
      const ranks = { high: 3, medium: 2, low: 1, info: 0 };
      if (ranks[a.severity] !== ranks[b.severity]) {
        return ranks[b.severity] - ranks[a.severity]; // worst first
      }
      return a.file.localeCompare(b.file);
    });
  }, [analysis?.issues]);

  const filteredGroups = useMemo(() => {
    if (activeFilter === 'All') return groupedIssues;
    return groupedIssues.map(g => ({
      ...g,
      issues: g.issues.filter(i => i.severity === activeFilter)
    })).filter(g => g.issues.length > 0);
  }, [groupedIssues, activeFilter]);

  const fileNodes = graph?.nodes?.filter(n => n.type === 'file') || [];

  const renderContent = () => {
    if (activeTab === 'chat') {
      return (
        <>
        {/* Tab Bar */}
        <div className="h-12 bg-surface border-b border-border px-2 flex items-center gap-1 flex-shrink-0">
          <button
            onClick={() => setActiveTab('health')}
            className="text-muted hover:text-white font-mono text-xs px-2 py-1.5 rounded-md hover:bg-surface-hover transition-colors"
          >
            ⬡ Health
          </button>
          <button
            onClick={() => setActiveTab('chat')}
            className="bg-bg text-white font-mono text-xs font-medium px-2 py-1.5 rounded-md"
          >
            ✦ Chat
          </button>
          <button
            onClick={() => setActiveTab('simulate')}
            className="text-muted hover:text-white font-mono text-xs px-2 py-1.5 rounded-md hover:bg-surface-hover transition-colors"
          >
            ⚡ Simulate
          </button>
        </div>
        <div className="flex-1 overflow-hidden relative">
          <ChatSidebar
            jobId={jobId}
            graph={graph}
            onNodeHighlight={onNodeHighlight}
            onNodeClick={onNodeClick}
          />
          </div>
        </>
      );
    }

    if (activeTab === 'simulate') {
      return (
        <>
        {/* Tab Bar */}
        <div className="h-12 bg-surface border-b border-border px-2 flex items-center gap-1 flex-shrink-0">
          <button
            onClick={() => setActiveTab('health')}
            className="text-muted hover:text-white font-mono text-xs px-2 py-1.5 rounded-md hover:bg-surface-hover transition-colors"
          >
            ⬡ Health
          </button>
          <button
            onClick={() => setActiveTab('chat')}
            className="text-muted hover:text-white font-mono text-xs px-2 py-1.5 rounded-md hover:bg-surface-hover transition-colors"
          >
            ✦ Chat
          </button>
          <button
            onClick={() => setActiveTab('simulate')}
            className="bg-bg text-white font-mono text-xs font-medium px-2 py-1.5 rounded-md"
          >
            ⚡ Simulate
          </button>
        </div>
        <div className="flex-1 overflow-hidden relative">
          <SimulatorPanel
            graph={graph}
            jobId={jobId}
            onBlastRadiusChange={onBlastRadiusChange}
            onSimulationModeChange={onSimulationModeChange}
            onNodeHighlight={onNodeHighlight}
            onNodeNavigate={onNodeClick}
            simulationSourceFile={simulationSourceFile}
          />
          </div>
        </>
      );
    }

    return (
      <>
      {/* Tab Bar */}
      <div className="h-12 bg-surface border-b border-border px-2 flex items-center gap-1 flex-shrink-0 justify-between">
        <div className="flex gap-1">
          <button
            onClick={() => setActiveTab('health')}
            className="bg-bg text-white font-mono text-xs font-medium px-2 py-1.5 rounded-md"
          >
            ⬡ Health
          </button>
          <button
            onClick={() => setActiveTab('chat')}
            className="text-muted hover:text-white font-mono text-xs px-2 py-1.5 rounded-md hover:bg-surface-hover transition-colors"
          >
            ✦ Chat
          </button>
          <button
            onClick={() => setActiveTab('simulate')}
            className="text-muted hover:text-white font-mono text-xs px-2 py-1.5 rounded-md hover:bg-surface-hover transition-colors"
          >
            ⚡ Simulate
          </button>
        </div>
        <button
          onClick={handleRefresh}
          className="text-muted hover:text-white text-sm px-2"
          title="Re-run analysis"
        >
          ↻
        </button>
      </div>

      {/* Health Tab Content */}
      <div className="flex-1 overflow-y-auto pb-6">
        {isLoading || !analysis ? (
          // Skeleton Loader
          <div className="animate-pulse">
            <div className="mx-3 mt-3 rounded-xl border border-border p-4 h-48 bg-surface-hover" />
            <div className="mx-3 mt-3 flex gap-2">
              <div className="flex-1 bg-surface-hover rounded-lg h-20" />
              <div className="flex-1 bg-surface-hover rounded-lg h-20" />
              <div className="flex-1 bg-surface-hover rounded-lg h-20" />
            </div>
            <div className="mx-3 mt-4 mb-2 h-4 w-32 bg-surface-hover rounded" />
            <div className="mx-3 mb-2 rounded-lg h-16 bg-surface-hover" />
            <div className="mx-3 mb-2 rounded-lg h-16 bg-surface-hover" />
            <div className="mx-3 mb-2 rounded-lg h-16 bg-surface-hover" />
          </div>
        ) : (
          <>
            {/* Section 1: Health score card */}
            <div
              className={`mx-3 mt-3 rounded-xl border p-4 ${
                analysis.grade === 'A' ? 'border-green-500/40 bg-green-500/8' :
                analysis.grade === 'B' ? 'border-green-400/40 bg-green-400/6' :
                analysis.grade === 'C' ? 'border-yellow-500/40 bg-yellow-500/8' :
                analysis.grade === 'D' ? 'border-orange-500/40 bg-orange-500/8' :
                'border-red-500/40 bg-red-500/8'
              }`}
            >
              <div className="text-6xl font-mono font-bold text-center" style={{ color: analysis.grade_color }}>
                {analysis.grade}
              </div>
              <div className="text-center font-mono text-sm text-muted mt-1">
                {analysis.score} / 100
              </div>
              <div className="text-center text-xs font-mono mt-0.5" style={{ color: analysis.grade_color }}>
                {analysis.grade === 'A' ? 'Excellent' :
                 analysis.grade === 'B' ? 'Good' :
                 analysis.grade === 'C' ? 'Fair' :
                 analysis.grade === 'D' ? 'Poor' : 'Critical'}
              </div>
              
              <div className="mt-4 grid grid-cols-2 gap-2">
                {[
                  { label: "Files", val: analysis.metrics?.total_files },
                  { label: "Functions", val: analysis.metrics?.total_functions },
                  { label: "Classes", val: analysis.metrics?.total_classes },
                  { label: "Avg Lines/Fn", val: analysis.metrics?.avg_function_length?.toFixed(0) },
                  { label: "Dead Code", val: analysis.metrics?.dead_code_count },
                  { label: "Circ. Imports", val: analysis.metrics?.circular_import_count },
                ].map((m, i) => (
                  <div key={i} className="bg-bg/50 rounded-lg p-2 text-center flex flex-col justify-center min-h-[50px]">
                    <div className="text-white font-mono text-sm font-medium">{m.val ?? 0}</div>
                    <div className="text-muted font-mono text-[10px] mt-0.5">{m.label}</div>
                  </div>
                ))}
              </div>
            </div>

            {/* Section 2: Issues summary bar */}
            <div className="mx-3 mt-3 flex gap-2">
              <div className="flex-1 bg-red-500/10 border border-red-500/30 rounded-lg p-2.5 text-center flex flex-col justify-center min-h-[64px]">
                <div className="w-1.5 h-1.5 rounded-full bg-red-500 mx-auto mb-1" />
                <div className="text-red-400 font-mono text-lg font-bold leading-none">{highCount}</div>
                <div className="text-xs text-muted font-mono mt-1 leading-none">High</div>
              </div>
              <div className="flex-1 bg-yellow-500/10 border border-yellow-500/30 rounded-lg p-2.5 text-center flex flex-col justify-center min-h-[64px]">
                <div className="w-1.5 h-1.5 rounded-full bg-yellow-500 mx-auto mb-1" />
                <div className="text-yellow-400 font-mono text-lg font-bold leading-none">{mediumCount}</div>
                <div className="text-xs text-muted font-mono mt-1 leading-none">Medium</div>
              </div>
              <div className="flex-1 bg-gray-500/10 border border-gray-500/30 rounded-lg p-2.5 text-center flex flex-col justify-center min-h-[64px]">
                <div className="w-1.5 h-1.5 rounded-full bg-gray-500 mx-auto mb-1" />
                <div className="text-gray-400 font-mono text-lg font-bold leading-none">{lowCount}</div>
                <div className="text-xs text-muted font-mono mt-1 leading-none">Low</div>
              </div>
            </div>

            {/* Section 3: Detected patterns */}
            {analysis.patterns && analysis.patterns.length > 0 && (
              <>
                <div className="text-xs font-mono text-muted uppercase tracking-wider mx-3 mt-4 mb-2">
                  PATTERNS DETECTED
                </div>
                {analysis.patterns.map((pattern, idx) => (
                  <div
                    key={idx}
                    className="mx-3 mb-2 bg-green-500/8 border border-green-500/25 rounded-lg px-3 py-2.5 cursor-pointer hover:bg-green-500/10 transition-colors"
                    onClick={() => {
                      const fileNode = graph?.nodes?.find(n => n.id === pattern.file);
                      if (fileNode && onNodeHighlight) onNodeHighlight([fileNode.id]);
                    }}
                  >
                    <div className="flex items-center gap-2">
                      <div className="w-2 h-2 rounded-full bg-green-500" />
                      <div className="text-green-400 font-mono text-xs font-medium">{pattern.name}</div>
                      <div className="ml-auto text-[10px] text-muted font-mono truncate max-w-[120px]" title={pattern.file}>
                        {pattern.file.split("/").at(-1)}
                      </div>
                    </div>
                    <div className="text-[11px] text-muted mt-1 font-sans leading-relaxed">
                      {pattern.description}
                    </div>
                  </div>
                ))}
              </>
            )}

            {/* Section 4: Issues list */}
            <div className="flex items-center justify-between mx-3 mt-4 mb-2">
              <div className="text-xs font-mono text-muted uppercase tracking-wider">ISSUES</div>
              <div className="flex gap-1">
                {['All', 'high', 'medium', 'low'].map(f => (
                  <button
                    key={f}
                    onClick={() => setActiveFilter(f)}
                    className={`text-[10px] font-mono px-2 py-0.5 rounded-full transition-colors ${
                      activeFilter === f ? 'bg-surface text-white' : 'text-muted hover:text-white'
                    }`}
                  >
                    {f === 'All' ? 'All' :
                     f === 'high' ? '🔴 High' :
                     f === 'medium' ? '🟡 Med' : '⚪ Low'}
                  </button>
                ))}
              </div>
            </div>

            {filteredGroups.length === 0 ? (
              <div className="mx-3 text-xs font-mono text-muted text-center py-4">No issues found.</div>
            ) : (
              filteredGroups.map(group => (
                <div key={group.file} className="mb-3">
                  {/* File Header */}
                  <div
                    className="flex items-center gap-2 mx-3 mt-2 mb-1 cursor-pointer hover:opacity-80"
                    onClick={() => {
                      const fileNode = graph?.nodes?.find(n => n.id === group.file);
                      if (fileNode) {
                        if (onNodeHighlight) onNodeHighlight([fileNode.id]);
                        if (onNodeClick) onNodeClick(fileNode);
                      }
                    }}
                    title={group.file}
                  >
                    <div className={`w-2 h-2 rounded-full flex-shrink-0 ${
                      group.severity === 'high' ? 'bg-red-500' :
                      group.severity === 'medium' ? 'bg-yellow-500' : 'bg-gray-500'
                    }`} />
                    <div className="font-mono text-xs text-white/80 truncate">
                      {group.file.split("/").at(-1)}
                    </div>
                    <div className={`ml-auto text-[10px] font-mono ${
                      group.severity === 'high' ? 'text-red-400' :
                      group.severity === 'medium' ? 'text-yellow-400' : 'text-gray-400'
                    }`}>
                      {group.issues.length}
                    </div>
                  </div>

                  {/* Issues */}
                  {group.issues.map(issue => (
                    <div
                      key={issue.id}
                      className={`mx-4 mb-1.5 rounded-lg px-2.5 py-2 text-xs font-sans cursor-pointer hover:opacity-80 transition-opacity ${
                        issue.severity === 'high' ? 'bg-red-500/8 border border-red-500/20' :
                        issue.severity === 'medium' ? 'bg-yellow-500/8 border border-yellow-500/20' :
                        issue.severity === 'low' ? 'bg-gray-500/8 border border-gray-500/20' :
                        'bg-green-500/8 border border-green-500/20'
                      }`}
                      onClick={() => {
                        // Find the exact node to click/highlight
                        const node = graph?.nodes?.find(n => 
                          (issue.function && n.label === issue.function && n.file === issue.file) ||
                          (!issue.function && n.id === issue.file)
                        ) || graph?.nodes?.find(n => n.id === issue.file);
                        
                        if (node) {
                          if (onNodeHighlight) onNodeHighlight([node.id]);
                          if (onNodeClick) onNodeClick(node);
                        }
                      }}
                    >
                      <div className="flex items-center gap-1.5">
                        <span className="text-[10px]">
                          {issue.severity === 'high' ? '🔴' :
                           issue.severity === 'medium' ? '🟡' : '⚪'}
                        </span>
                        <span className={`text-[10px] font-mono uppercase ${
                          issue.type === 'security' ? 'text-red-400' :
                          issue.type === 'quality' ? 'text-yellow-400' :
                          issue.type === 'pattern' ? 'text-green-400' : 'text-gray-400'
                        }`}>
                          {issue.type}
                        </span>
                        <span className="ml-auto text-[10px] text-muted font-mono">
                          :{issue.line}
                        </span>
                      </div>
                      <div className="text-[11px] text-white/70 mt-1 leading-relaxed">
                        {issue.message}
                      </div>
                      {issue.function && (
                        <div className="text-[10px] text-muted font-mono mt-0.5">
                          in {issue.function}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              ))
            )}

            {/* Section 5: File health heatmap */}
            <div className="text-xs font-mono text-muted uppercase tracking-wider mx-3 mt-6 mb-2 border-t border-border pt-4">
              FILE HEALTH
            </div>
            <div className="mx-3 flex flex-wrap gap-1.5 pb-4">
              {fileNodes.map(fn => {
                const fa = analysis?.by_file?.[fn.id];
                const sev = fa ? fa.severity : null;
                const c = 
                  sev === 'high' ? 'bg-red-500/20 text-red-400 border border-red-500/30' :
                  sev === 'medium' ? 'bg-yellow-500/20 text-yellow-400 border border-yellow-500/30' :
                  sev === 'low' ? 'bg-gray-500/20 text-gray-400 border border-gray-500/30' :
                  'bg-green-500/20 text-green-400 border border-green-500/30';
                
                return (
                  <div
                    key={fn.id}
                    className={`rounded px-2 py-1 font-mono text-[10px] cursor-pointer hover:opacity-80 transition-opacity ${c}`}
                    title={fn.id}
                    onClick={() => {
                      if (onNodeHighlight) onNodeHighlight([fn.id]);
                      if (onNodeClick) onNodeClick(fn);
                    }}
                  >
                    {fn.id.split("/").at(-1)}
                  </div>
                );
              })}
            </div>
          </>
        )}
      </div>
      </>
    );
  };

  return (
    <>
      {/* Mobile Backdrop */}
      <div 
        className={`md:hidden fixed inset-0 bg-black/60 backdrop-blur-sm z-40 transition-opacity duration-300 ${hidden ? 'opacity-0 pointer-events-none' : 'opacity-100'}`}
        onClick={onClose}
      />
      
      {/* Drawer Container */}
      <div className={`fixed md:relative inset-y-0 right-0 z-50 w-[320px] max-w-[85vw] flex-shrink-0 h-full bg-bg border-l border-border flex flex-col transition-transform duration-300 md:transition-none ${hidden ? 'max-md:translate-x-full md:hidden' : 'translate-x-0'}`}>
        {renderContent()}
      </div>
    </>
  );
}
