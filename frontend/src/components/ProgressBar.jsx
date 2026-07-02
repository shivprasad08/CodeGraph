import { useState, useEffect } from 'react';

export default function ProgressBar({ progress, stage, message, startedAt, status }) {
  const [elapsedSeconds, setElapsedSeconds] = useState(0);

  useEffect(() => {
    if (!startedAt || status === "done" || status === "error") {
      return;
    }
    
    const interval = setInterval(() => {
      const now = new Date();
      setElapsedSeconds(Math.floor((now - startedAt) / 1000));
    }, 1000);
    
    // Initial calculation to prevent 1s delay
    setElapsedSeconds(Math.floor((new Date() - startedAt) / 1000));

    return () => clearInterval(interval);
  }, [startedAt, status]);

  const stages = [
    { id: 'queued', label: 'Fetch' },
    { id: 'ingestion', label: 'Fetch' },
    { id: 'parsing', label: 'Parse' },
    { id: 'graph', label: 'Graph' },
    { id: 'enrichment', label: 'Enrich' },
    { id: 'done', label: 'Done' }
  ];
  
  // Condense queued and ingestion into the first visual pill (Fetch)
  const displayStages = [
    { id: 'ingestion', label: 'Fetch' },
    { id: 'parsing', label: 'Parse' },
    { id: 'graph', label: 'Graph' },
    { id: 'enrichment', label: 'Enrich' },
    { id: 'done', label: 'Done' }
  ];

  const currentStageIndex = displayStages.findIndex(s => s.id === stage || (stage === 'queued' && s.id === 'ingestion'));
  const activeIndex = currentStageIndex === -1 ? 0 : currentStageIndex;

  const isRunning = status === 'running' || status === 'queued';

  let remainingText = null;
  if (isRunning && progress > 5 && elapsedSeconds > 0) {
    const rate = progress / elapsedSeconds;
    const remaining = Math.ceil((100 - progress) / rate);
    remainingText = `~${remaining}s remaining`;
  }

  const formatElapsed = (sec) => {
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    return `${m}:${s.toString().padStart(2, '0')}`;
  };

  return (
    <div className="w-full">
      <div className="flex justify-between items-end mb-2">
        <div className="font-mono text-sm text-muted">
          {message || "Waiting..."}
        </div>
        <div className="text-right flex flex-col items-end">
          {elapsedSeconds > 0 && (
            <div className="text-xs text-muted font-mono">
              {formatElapsed(elapsedSeconds)} elapsed
            </div>
          )}
          {remainingText && (
            <div className="text-xs text-muted font-mono mt-0.5">
              {remainingText}
            </div>
          )}
        </div>
      </div>
      
      <div className="w-full bg-surface border border-border rounded-full h-2 overflow-hidden relative">
        <div 
          className="h-full bg-accent glow-accent relative overflow-hidden"
          style={{ 
            width: `${progress}%`,
            transition: 'width 0.5s ease-in-out'
          }}
        >
          {isRunning && (
            <div className="absolute inset-0 bg-gradient-to-r from-transparent via-white/10 to-transparent animate-shimmer" />
          )}
        </div>
      </div>
      
      <div className="mt-6 flex items-center justify-between relative px-2">
        {/* Connecting Line */}
        <div className="absolute left-6 right-6 top-1/2 -translate-y-1/2 h-[1px] bg-border z-0" />
        <div 
          className="absolute left-6 top-1/2 -translate-y-1/2 h-[1px] bg-success z-0 transition-all duration-500" 
          style={{ width: `calc(${Math.min(activeIndex, displayStages.length - 1) / (displayStages.length - 1)} * (100% - 3rem))` }}
        />

        {displayStages.map((s, idx) => {
          const isCompleted = idx < activeIndex || status === 'done';
          const isActive = idx === activeIndex && isRunning;
          
          let pillColor = 'bg-surface text-muted border border-border';
          if (isCompleted) pillColor = 'bg-success/20 text-success border border-success/40';
          if (isActive) pillColor = 'bg-accent/20 text-accent border border-accent/40 animate-pulse-slow';
          
          return (
            <div key={s.id} className={`relative z-10 rounded-full px-2.5 py-1 text-xs font-mono transition-all duration-300 ${pillColor}`}>
              {s.label}
            </div>
          );
        })}
      </div>
    </div>
  );
}
