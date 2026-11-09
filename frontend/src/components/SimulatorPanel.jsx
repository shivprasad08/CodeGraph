import { useEffect, useRef, useState } from 'react';
import { CornerDownRight, X, Zap } from 'lucide-react';
import { API_ERROR, streamImpactAnalysis } from '../api';
import { computeBlastRadius, detectBrokenPipelines } from '../utils/blastRadius';
import { cn } from '../lib/cn';
import { Badge, Button, IconButton, Input, focusRing } from '../ui';
import { TYPE_DOT, typeKey } from './app/NodeDetails';
import { InlineError, RecoveryNotice } from './app/RecoveryStatus';

const RISK = {
  SAFE: ['bg-cg-success', 'Safe', 'Change appears low-risk'],
  CAUTION: ['bg-cg-sev-med', 'Caution', 'Review the affected components'],
  RISKY: ['bg-cg-sev-high', 'Risky', 'A significant cascade is possible'],
  DANGEROUS: ['bg-cg-sev-high', 'Dangerous', 'High risk of breaking changes'],
};
const CHANGE_IDEAS = ['Change the logic', 'Rename this', 'Add a parameter', 'Remove this function'];

/**
 * Impact tab: pick a node, optionally describe the change, run the blast-radius
 * simulation (computed locally) and, when online, the AI impact analysis.
 */
export default function SimulatorPanel({
  graph,
  onBlastRadiusChange,
  onSimulationModeChange,
  onNodeHighlight,
  onNodeNavigate,
  simulationSourceFile,
  offline = false, // static demo: blast radius runs locally, AI analysis needs the backend
  onRerun,
  onReloadGraph,
}) {
  const [searchTerm, setSearchTerm] = useState('');
  const [selectedNode, setSelectedNode] = useState(null);
  const [changeDescription, setChangeDescription] = useState('');
  const [resultVisible, setResultVisible] = useState(false);
  const [isLoadingLLM, setIsLoadingLLM] = useState(false);
  const [llmResponse, setLLMResponse] = useState('');
  const [riskLevel, setRiskLevel] = useState(null);
  const [llmError, setLLMError] = useState(null); // ApiError: friendly message + code
  const [recovering, setRecovering] = useState(false);
  const [changedJobId, setChangedJobId] = useState(null);
  const [blastResult, setBlastResult] = useState(null);
  const [brokenPipelines, setBrokenPipelines] = useState([]);
  const responseEndRef = useRef(null);

  // Pre-select a node passed in from Details or the file menu
  useEffect(() => {
    if (simulationSourceFile && graph?.nodes) {
      const node = graph.nodes.find((n) => n.id === simulationSourceFile);
      if (node) setSelectedNode(node);
    }
  }, [simulationSourceFile, graph]);

  useEffect(() => {
    if (isLoadingLLM) responseEndRef.current?.scrollIntoView({ block: 'nearest' });
  }, [llmResponse, isLoadingLLM]);

  const selectSource = (node) => {
    setSelectedNode(node);
    setSearchTerm('');
    onNodeHighlight?.([node.id]);
  };

  const exitSimulation = () => {
    onSimulationModeChange?.(false);
    onBlastRadiusChange?.(null);
    setResultVisible(false);
    setBlastResult(null);
    setLLMResponse('');
    setRiskLevel(null);
  };

  const clearSelection = () => {
    setSelectedNode(null);
    if (resultVisible) exitSimulation();
  };

  const runSimulation = () => {
    if (!selectedNode || !graph) return;
    setLLMResponse('');
    setRiskLevel(null);
    setLLMError(null);

    const blast = computeBlastRadius(graph, [selectedNode.id]);
    const pipelines = detectBrokenPipelines(graph, new Set(blast.affected.keys()));
    setBlastResult(blast);
    setBrokenPipelines(pipelines);
    onBlastRadiusChange?.(blast);
    onSimulationModeChange?.(true);
    setResultVisible(true);

    if (offline) {
      setLLMResponse('AI impact analysis is available on your own analyses.');
      return;
    }
    setIsLoadingLLM(true);
    streamImpactAnalysis(
      graph.repo,
      graph.commit_sha,
      selectedNode.id,
      changeDescription,
      {
        affected_count: blast.stats.total,
        critical_nodes: [...blast.affected.entries()].filter(([, d]) => d.severity === 'critical').map(([id]) => id),
        broken_pipelines: pipelines.map((p) => ({ entry_point: p.entryPoint.id, risk: p.risk })),
      },
      (token) => setLLMResponse((prev) => prev + token),
      ({ riskLevel: level }) => {
        setRiskLevel(level);
        setIsLoadingLLM(false);
      },
      (message, apiError) => {
        setLLMError({ message, code: apiError?.code });
        setRecovering(false);
        setIsLoadingLLM(false);
      },
      {
        onRecovering: () => setRecovering(true),
        onRecovered: ({ changed, jobId }) => {
          setRecovering(false);
          if (changed) setChangedJobId(jobId);
        },
      },
    );
  };

  const searchResults =
    searchTerm && graph?.nodes
      ? graph.nodes
          .filter((n) => n.label.toLowerCase().includes(searchTerm.toLowerCase()) || n.file?.toLowerCase().includes(searchTerm.toLowerCase()))
          .slice(0, 10)
      : [];

  const nodeById = (id) => graph?.nodes?.find((n) => n.id === id || n.label === id);

  const renderLLMText = (text) =>
    text.split(/`([^`]+)`/g).map((part, i) => {
      if (i % 2 === 0) return <span key={i}>{part}</span>;
      const target = nodeById(part);
      return target ? (
        <button
          key={i}
          type="button"
          onClick={() => {
            onNodeHighlight?.([target.id]);
            onNodeNavigate?.(target);
          }}
          className={cn('mx-0.5 rounded border border-cg-border-strong px-1 font-cg-mono text-cg-xs text-cg-text hover:bg-cg-hover', focusRing)}
        >
          {part}
        </button>
      ) : (
        <code key={i} className="mx-0.5 rounded bg-cg-overlay px-1 font-cg-mono text-cg-xs text-cg-text">
          {part}
        </code>
      );
    });

  const affectedBy = (sev) => (blastResult ? [...blastResult.affected.entries()].filter(([, d]) => d.severity === sev) : []);
  const AffectedRow = ({ id, depth }) => {
    const node = nodeById(id);
    return (
      <button
        type="button"
        onClick={() => node && onNodeNavigate?.(node)}
        style={{ paddingLeft: depth * 12 }}
        className={cn('flex h-7 w-full items-center gap-1.5 rounded text-left text-cg-sm text-cg-text hover:bg-cg-hover [@media(pointer:coarse)]:min-h-11', focusRing)}
      >
        <CornerDownRight size={14} strokeWidth={1.5} aria-hidden="true" className="shrink-0 text-cg-tertiary" />
        <span className="truncate">{node?.label || id}</span>
      </button>
    );
  };

  const sectionTitle = 'text-cg-xs font-medium text-cg-secondary';

  return (
    <div className="flex flex-col gap-5 p-4">
      <section>
        <h3 className={sectionTitle}>Node to change</h3>
        {!selectedNode ? (
          <div className="relative mt-2">
            <Input
              label="Search files or functions"
              hideLabel
              placeholder="Search files or functions"
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              autoComplete="off"
            />
            {searchResults.length > 0 && (
              <ul className="absolute inset-x-0 top-full z-20 mt-1 max-h-60 overflow-y-auto rounded-cg-control border border-cg-border bg-cg-overlay p-1 shadow-cg-edge">
                {searchResults.map((n) => (
                  <li key={n.id}>
                    <button
                      type="button"
                      onClick={() => selectSource(n)}
                      className={cn('flex h-8 w-full items-center gap-2 rounded-[6px] px-2 text-left text-cg-sm hover:bg-cg-hover [@media(pointer:coarse)]:min-h-11', focusRing)}
                    >
                      <span aria-hidden="true" className={cn('h-1.5 w-1.5 shrink-0 rounded-full', TYPE_DOT[typeKey(n)])} />
                      <span className="truncate text-cg-text">{n.label}</span>
                      <span className="ml-auto max-w-[45%] truncate font-cg-mono text-cg-xs text-cg-tertiary">{n.file}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
            <p className="mt-3 text-cg-sm text-cg-tertiary">Select a node, then run Simulate impact.</p>
          </div>
        ) : (
          <div className="mt-2 flex items-center gap-2 rounded-cg-control border border-cg-border bg-cg-canvas py-2 pl-3 pr-1">
            <span aria-hidden="true" className={cn('h-2 w-2 shrink-0 rounded-full', TYPE_DOT[typeKey(selectedNode)])} />
            <div className="min-w-0 flex-1">
              <p className="truncate text-cg-sm font-medium text-cg-text">{selectedNode.label}</p>
              <p className="truncate font-cg-mono text-cg-xs text-cg-tertiary">{selectedNode.file}</p>
            </div>
            <IconButton label="Clear selection" size="sm" onClick={clearSelection}>
              <X size={16} strokeWidth={1.5} aria-hidden="true" />
            </IconButton>
          </div>
        )}
      </section>

      <section>
        <label htmlFor="change-description" className={sectionTitle}>
          Describe the change <span className="text-cg-tertiary">(optional)</span>
        </label>
        <textarea
          id="change-description"
          value={changeDescription}
          onChange={(e) => setChangeDescription(e.target.value)}
          placeholder="For example: change token expiry from 24h to 1h"
          rows={3}
          className="mt-2 w-full resize-none rounded-cg-control border border-cg-border-strong bg-cg-canvas px-3 py-2 text-cg-sm text-cg-text outline-none placeholder:text-cg-tertiary focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cg-focus [@media(pointer:coarse)]:text-[16px]"
        />
        <div className="mt-2 flex flex-wrap gap-1.5">
          {CHANGE_IDEAS.map((idea) => (
            <Badge key={idea} onClick={() => setChangeDescription(idea)} selected={changeDescription === idea}>
              {idea}
            </Badge>
          ))}
        </div>
      </section>

      <Button
        variant="primary"
        onClick={runSimulation}
        disabled={!selectedNode}
        loading={isLoadingLLM}
        leadingIcon={<Zap size={16} strokeWidth={1.5} aria-hidden="true" />}
        className="w-full"
      >
        Simulate impact
      </Button>

      {resultVisible && blastResult && (
        <div className="flex flex-col gap-5 border-t border-cg-border pt-5">
          {!offline && (
            <p className="flex items-center gap-2 text-cg-sm" aria-live="polite">
              {riskLevel ? (
                <>
                  <span aria-hidden="true" className={cn('h-2 w-2 rounded-full', (RISK[riskLevel] ?? RISK.DANGEROUS)[0])} />
                  <span className="font-medium text-cg-text">{(RISK[riskLevel] ?? [null, riskLevel])[1]}</span>
                  <span className="text-cg-secondary">· {(RISK[riskLevel] ?? [null, null, ''])[2]}</span>
                </>
              ) : (
                <span className="text-cg-tertiary">Assessing risk…</span>
              )}
            </p>
          )}

          <dl className="grid grid-cols-3 gap-3">
            {[
              ['Affected', blastResult.stats.total],
              ['Direct', blastResult.stats.bySeverity.critical || 0],
              ['Pipelines', brokenPipelines.length],
            ].map(([label, value]) => (
              <div key={label}>
                <dt className="text-cg-xs text-cg-tertiary">{label}</dt>
                <dd className="text-cg-xl tabular-nums text-cg-text">{value}</dd>
              </div>
            ))}
          </dl>

          <section>
            <h3 className={sectionTitle}>Impact cascade</h3>
            <div className="mt-2 flex flex-col">
              <p className="truncate text-cg-sm font-medium text-cg-text">{selectedNode.label}</p>
              {affectedBy('critical').slice(0, 4).map(([id]) => (
                <AffectedRow key={id} id={id} depth={1} />
              ))}
              {affectedBy('critical').length > 4 && (
                <p className="pl-8 text-cg-xs text-cg-tertiary">+ {affectedBy('critical').length - 4} more direct dependents</p>
              )}
              {affectedBy('high').slice(0, 3).map(([id]) => (
                <AffectedRow key={id} id={id} depth={2} />
              ))}
              {affectedBy('high').length > 3 && (
                <p className="pl-11 text-cg-xs text-cg-tertiary">+ {affectedBy('high').length - 3} more at the second level</p>
              )}
              {(() => {
                const deeper = [...blastResult.affected.values()].filter((d) => d.depth >= 3).length;
                return deeper ? <p className="pl-11 text-cg-xs text-cg-tertiary">{deeper} more transitive dependents</p> : null;
              })()}
            </div>
          </section>

          {brokenPipelines.length > 0 && (
            <section>
              <h3 className={sectionTitle}>Pipelines at risk</h3>
              <ul className="mt-2 flex flex-col">
                {brokenPipelines.map((p, i) => (
                  <li key={i}>
                    <button
                      type="button"
                      onClick={() => onNodeNavigate?.(p.entryPoint)}
                      className={cn('flex w-full items-center gap-2 rounded py-1.5 text-left hover:bg-cg-hover [@media(pointer:coarse)]:min-h-11', focusRing)}
                    >
                      <span aria-hidden="true" className={cn('h-1.5 w-1.5 shrink-0 rounded-full', p.risk === 'high' ? 'bg-cg-sev-high' : 'bg-cg-sev-med')} />
                      <span className="min-w-0 flex-1 truncate text-cg-sm text-cg-text">{p.entryPoint.label}</span>
                      <span className="shrink-0 text-cg-xs text-cg-tertiary">{p.affectedInPath.length} affected</span>
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          )}

          <section>
            <h3 className={sectionTitle}>AI impact analysis</h3>
            {changedJobId && (
              <RecoveryNotice className="mt-2" onReloadGraph={onReloadGraph ? () => onReloadGraph(changedJobId) : undefined} />
            )}
            {llmError ? (
              <InlineError
                className="mt-2"
                message={llmError.message}
                onRerun={llmError.code === API_ERROR.CACHE_MISS ? onRerun : undefined}
              />
            ) : (
              <div className="mt-2 whitespace-pre-wrap rounded-cg-control border border-cg-border bg-cg-canvas p-3 text-cg-sm text-cg-secondary">
                {llmResponse ? (
                  renderLLMText(llmResponse)
                ) : isLoadingLLM ? (
                  <span className="text-cg-tertiary">{recovering ? 'Reloading this analysis on the server…' : 'Writing the analysis…'}</span>
                ) : null}
                <div ref={responseEndRef} />
              </div>
            )}
          </section>

          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              variant="secondary"
              onClick={() => {
                const firstCritical = affectedBy('critical')[0]?.[0];
                const target = nodeById(firstCritical || selectedNode.id);
                if (target) onNodeNavigate?.(target);
              }}
            >
              View affected code
            </Button>
            <Button size="sm" variant="ghost" onClick={exitSimulation}>
              Exit simulation
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
