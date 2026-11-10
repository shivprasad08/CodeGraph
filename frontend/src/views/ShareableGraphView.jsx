// Page pattern: split pane — file tree | graph canvas (+ status bar) | inspector.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { Panel, PanelGroup, PanelResizeHandle } from 'react-resizable-panels';
import { FileX, TriangleAlert, X } from 'lucide-react';
import { analyzeRepo, fetchAnalysis, fetchGraph, fetchRepo, subscribeToJob } from '../api';
import { buildDirectoryColorMap } from '../utils/directoryColors';
import { isPlainKey, isTypingTarget } from '../lib/hotkeys';
import { readStorage, safePanelStorage, writeStorage } from '../lib/storage';
import { cn } from '../lib/cn';
import { Button, Dialog, DialogContent, IconButton } from '../ui';
import GraphCanvas from '../components/GraphCanvas';
import FileTree from '../components/FileTree';
import CodeInspector from '../components/CodeInspector';
import ProgressBar from '../components/ProgressBar';
import AppTopBar, { TopBarFrame } from '../components/app/AppTopBar';
import Inspector, { INSPECTOR_TABS } from '../components/app/Inspector';
import StatusBar from '../components/app/StatusBar';
import GraphLegend from '../components/app/GraphLegend';
import CommandPalette from '../components/app/CommandPalette';
import ArchitectureView from '../components/app/ArchitectureView';
import SegmentedControl from '../ui/SegmentedControl';

const CANVAS_VIEWS = [
  { value: 'graph', label: 'Graph' },
  { value: 'architecture', label: 'Architecture' },
];

const MOBILE_QUERY = '(max-width: 767px)';
const LEFT_PX = { default: 264, min: 200, max: 420 };
const RIGHT_PX = { default: 380, min: 300, max: 560 };
const SMALL_SCREEN_NOTE_KEY = 'codegraph:small-screen-note-dismissed';
const EMPTY_SET = new Set();

function useIsMobile() {
  const get = () => typeof window !== 'undefined' && !!window.matchMedia?.(MOBILE_QUERY).matches;
  const [mobile, setMobile] = useState(get);
  useEffect(() => {
    const mq = window.matchMedia?.(MOBILE_QUERY);
    if (!mq) return undefined;
    const onChange = () => setMobile(mq.matches);
    mq.addEventListener?.('change', onChange);
    return () => mq.removeEventListener?.('change', onChange);
  }, []);
  return mobile;
}

function ResizeHandle({ label }) {
  return (
    <PanelResizeHandle
      aria-label={label}
      className={cn(
        'relative w-px shrink-0 bg-cg-border outline-none transition-colors duration-cg-fast ease-cg',
        // Wider hit area than the visible hairline
        "before:absolute before:inset-y-0 before:-left-1.5 before:w-3 before:content-['']",
        'data-[resize-handle-state=hover]:bg-cg-border-strong data-[resize-handle-state=drag]:bg-cg-text',
        'focus-visible:bg-cg-text',
      )}
    />
  );
}

/** Centered message in the canvas column (errors). */
function CenterMessage({ icon, title, body, actions }) {
  return (
    <div className="flex flex-1 items-center justify-center p-6">
      <div className="max-w-sm text-center">
        {icon}
        <h1 className="mt-3 text-cg-lg font-semibold text-cg-text">{title}</h1>
        {body && <p className="mt-1 text-cg-sm text-cg-secondary">{body}</p>}
        {actions && <div className="mt-5 flex flex-wrap justify-center gap-2">{actions}</div>}
      </div>
    </div>
  );
}

/**
 * Graph app view. With `staticData` (a saved /graph response) it renders that graph
 * without calling the backend; features that need the server show a short note.
 */
export default function ShareableGraphView({ staticData = null } = {}) {
  const params = useParams();
  const offline = Boolean(staticData);
  const [owner, repo] = offline ? (staticData.repo || '/').split('/') : [params.owner, params.repo];
  const jobId = offline ? undefined : params.jobId;
  const navigate = useNavigate();
  const isMobile = useIsMobile();

  // ---- Data -----------------------------------------------------------------
  const [graphData, setGraphData] = useState(staticData);
  const [analysis, setAnalysis] = useState(staticData?.analysis ?? null);
  const [analysisLoading, setAnalysisLoading] = useState(false);
  const [jobStatus, setJobStatus] = useState(offline ? 'done' : null);
  const [error, setError] = useState(null);
  const [errorCode, setErrorCode] = useState(null); // "no_source", "file_limit"… from the job stream
  const [progress, setProgress] = useState(0);
  const [stage, setStage] = useState('queued');
  const [message, setMessage] = useState('Queued');
  const [startedAt, setStartedAt] = useState(null);

  useEffect(() => {
    document.title = `CodeGraph — ${owner}/${repo}`;
    // Static demo: the graph is already loaded and there is no backend to call
    if (offline) return undefined;

    const loadAnalysis = (graph, id) => {
      if (graph.analysis) setAnalysis(graph.analysis);
      else if (id) {
        setAnalysisLoading(true);
        fetchAnalysis(id)
          .then(setAnalysis)
          .catch(() => {})
          .finally(() => setAnalysisLoading(false));
      }
    };

    if (jobId) {
      setJobStatus('analyzing');
      setStartedAt(Date.now());
      return subscribeToJob(
        jobId,
        (data) => {
          setProgress(data.progress);
          setStage(data.stage);
          setMessage(data.message);
        },
        (errMsg, code) => {
          setError(errMsg);
          setErrorCode(code ?? null);
          setJobStatus('error');
        },
        async () => {
          try {
            const finalGraph = await fetchGraph(jobId);
            setGraphData(finalGraph);
            setJobStatus('done');
            loadAnalysis(finalGraph, jobId);
          } catch (err) {
            setError(err.message || 'The graph could not be loaded after the analysis finished');
            setJobStatus('error');
          }
        },
      );
    }

    (async () => {
      try {
        const res = await fetchRepo(owner, repo);
        if (res.status === 'cached') {
          setGraphData(res.graph);
          setJobStatus('done');
          loadAnalysis(res.graph, null);
        } else if (res.status === 'analyzing') {
          navigate(`/graph/${owner}/${repo}/jobs/${res.job_id}`, { replace: true });
        }
      } catch (err) {
        setError(err.message || `Could not analyze ${owner}/${repo}`);
        setJobStatus('error');
      }
    })();
    return undefined;
  }, [owner, repo, jobId, navigate, offline]);

  const dirColorMap = useMemo(() => (graphData ? buildDirectoryColorMap(graphData.nodes) : {}), [graphData]);

  // ---- Selection & panels ----------------------------------------------------
  const [selectedNode, setSelectedNode] = useState(null);
  const [selectedFilePath, setSelectedFilePath] = useState(null);
  const [highlightedNodeIds, setHighlightedNodeIds] = useState(EMPTY_SET);
  const [chatHighlightedNodeIds, setChatHighlightedNodeIds] = useState(EMPTY_SET);
  const [zoomToNodes, setZoomToNodes] = useState(null);
  const [simulationMode, setSimulationMode] = useState(false);
  const [blastRadius, setBlastRadius] = useState(null);
  const [simulationSource, setSimulationSource] = useState(null);
  const [tab, setTab] = useState('details');
  const [canvasView, setCanvasView] = useState('graph'); // 'graph' | 'architecture'
  const [code, setCode] = useState(null); // { file, line }
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [recentIds, setRecentIds] = useState([]);
  const [hullsVisible, setHullsVisible] = useState(true);
  const [hiddenDirs, setHiddenDirs] = useState(EMPTY_SET);
  const [leftOpen, setLeftOpen] = useState(true);
  const [rightOpen, setRightOpen] = useState(true);
  const [filesSheet, setFilesSheet] = useState(false);
  const [inspectorSheet, setInspectorSheet] = useState(false);
  const [showSmallNote, setShowSmallNote] = useState(() => !readStorage(SMALL_SCREEN_NOTE_KEY, false));
  const [notice, setNotice] = useState(null);
  const [rerunning, setRerunning] = useState(false);

  const canvasRef = useRef(null);
  const leftPanelRef = useRef(null);
  const rightPanelRef = useRef(null);
  const zoomListener = useRef(null);

  // Panel sizes are percentages in react-resizable-panels v3; derive them from pixels once
  const [sizes] = useState(() => {
    const w = Math.max(window.innerWidth, 768);
    const pct = (px) => Math.min(60, (px / w) * 100);
    return {
      left: { defaultSize: pct(LEFT_PX.default), minSize: pct(LEFT_PX.min), maxSize: pct(LEFT_PX.max) },
      right: { defaultSize: pct(RIGHT_PX.default), minSize: pct(RIGHT_PX.min), maxSize: pct(RIGHT_PX.max) },
    };
  });

  // The panel API throws until the group has registered its sizes, so every call is guarded
  const panelCall = (ref, method) => {
    try {
      return ref.current?.[method]?.();
    } catch {
      return undefined;
    }
  };

  // A saved layout may start with a panel collapsed; read it once the group has laid out
  useEffect(() => {
    if (isMobile) return undefined;
    const id = requestAnimationFrame(() => {
      const left = panelCall(leftPanelRef, 'isCollapsed');
      const right = panelCall(rightPanelRef, 'isCollapsed');
      if (left !== undefined) setLeftOpen(!left);
      if (right !== undefined) setRightOpen(!right);
    });
    return () => cancelAnimationFrame(id);
  }, [isMobile, graphData]);

  const showInspector = useCallback(() => {
    if (isMobile) setInspectorSheet(true);
    else panelCall(rightPanelRef, 'expand');
  }, [isMobile]);

  const toggleLeft = useCallback(() => {
    if (isMobile) return setFilesSheet((v) => !v);
    return panelCall(leftPanelRef, panelCall(leftPanelRef, 'isCollapsed') ? 'expand' : 'collapse');
  }, [isMobile]);

  const toggleRight = useCallback(() => {
    if (isMobile) return setInspectorSheet((v) => !v);
    return panelCall(rightPanelRef, panelCall(rightPanelRef, 'isCollapsed') ? 'expand' : 'collapse');
  }, [isMobile]);

  const remember = (id) => setRecentIds((prev) => [id, ...prev.filter((x) => x !== id)].slice(0, 8));

  const selectNode = useCallback(
    (node, { openDetails = true } = {}) => {
      if (!node) {
        setSelectedNode(null);
        setHighlightedNodeIds(EMPTY_SET);
        setSelectedFilePath(null);
        return;
      }
      setSelectedNode(node);
      setHighlightedNodeIds(new Set([node.id]));
      remember(node.id);
      setCode((c) => (c && node.type !== 'file' && node.file && c.file !== node.file ? { file: node.file } : c));
      if (openDetails) {
        setTab('details');
        if (!isMobile) panelCall(rightPanelRef, 'expand');
      }
    },
    [isMobile],
  );

  const selectFromPalette = (node) => {
    selectNode(node);
    setZoomToNodes([node.id]);
    if (isMobile) setInspectorSheet(true);
  };

  const handleFileSelect = (filePath) => {
    if (!graphData) return;
    if (selectedFilePath === filePath) {
      // Second click toggles the code view, as before
      setCode((c) => (c?.file === filePath ? null : { file: filePath }));
      return;
    }
    setSelectedFilePath(filePath);
    setCode({ file: filePath });
    const ids = new Set(graphData.nodes.filter((n) => n.file === filePath || n.id === filePath).map((n) => n.id));
    setHighlightedNodeIds(ids);
    setZoomToNodes([...ids]);
    const fileNode = graphData.nodes.find((n) => n.id === filePath);
    if (fileNode) {
      setSelectedNode(fileNode);
      remember(fileNode.id);
    }
    if (isMobile) setFilesSheet(false);
  };

  const viewSource = (node, line) => {
    const file = node.type === 'file' ? node.id : node.file;
    if (!file) return;
    setSelectedFilePath(file);
    setCode({ file, line });
    if (isMobile) setInspectorSheet(false);
  };

  const simulate = (nodeOrId) => {
    setSimulationSource(typeof nodeOrId === 'string' ? nodeOrId : nodeOrId.id);
    setTab('impact');
    showInspector();
    if (isMobile) setFilesSheet(false);
  };

  // Diagram click: a module highlights and zooms to its files (main file in Details);
  // a flow node selects and zooms to that node. Either way the graph is shown.
  const handleDiagramNode = (specNode) => {
    if (!graphData) return;
    setCanvasView('graph');
    if (specNode.members) {
      const files = new Set(specNode.members);
      const ids = graphData.nodes.filter((n) => files.has(n.type === 'file' ? n.id : n.file)).map((n) => n.id);
      const mainFile = graphData.nodes.find((n) => n.id === specNode.nodeRef);
      if (mainFile) selectNode(mainFile);
      setHighlightedNodeIds(new Set(ids));
      setZoomToNodes(ids);
      return;
    }
    const node = graphData.nodes.find((n) => n.id === specNode.nodeRef);
    if (node) {
      selectNode(node);
      setZoomToNodes([node.id]);
    }
  };

  const handleChatHighlight = useCallback((ids) => {
    setChatHighlightedNodeIds(new Set(ids));
    if (ids.length) setZoomToNodes([...ids]);
  }, []);
  useEffect(() => {
    if (!chatHighlightedNodeIds.size) return undefined;
    const t = setTimeout(() => setChatHighlightedNodeIds(EMPTY_SET), 5000);
    return () => clearTimeout(t);
  }, [chatHighlightedNodeIds]);

  const effectiveHighlights = useMemo(
    () => (chatHighlightedNodeIds.size ? new Set([...highlightedNodeIds, ...chatHighlightedNodeIds]) : highlightedNodeIds),
    [highlightedNodeIds, chatHighlightedNodeIds],
  );

  const exitSimulation = () => {
    setSimulationMode(false);
    setBlastRadius(null);
  };

  const rerun = async () => {
    if (offline || rerunning) return;
    setRerunning(true);
    setNotice(null);
    try {
      const res = await analyzeRepo(`https://github.com/${owner}/${repo}`);
      navigate(`/graph/${owner}/${repo}/jobs/${res.job_id}`);
    } catch (err) {
      setNotice(`Couldn't start a new analysis: ${(err.message || 'no response').replace(/\.\s*$/, '')}. Try again in a minute.`);
    } finally {
      setRerunning(false);
    }
  };

  // A recovered analysis landed on a newer commit: open that finished job
  const reloadGraph = (newJobId) => navigate(`/graph/${owner}/${repo}/jobs/${newJobId}`);

  // ---- Keyboard ---------------------------------------------------------------
  const stateRef = useRef({});
  stateRef.current = { simulationMode, code, selectedNode, selectedFilePath, paletteOpen, filesSheet, inspectorSheet };
  useEffect(() => {
    const onKeyDown = (e) => {
      const s = stateRef.current;
      if ((e.metaKey || e.ctrlKey) && !e.altKey && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setPaletteOpen((v) => !v);
        return;
      }
      if (e.defaultPrevented || isTypingTarget(e.target) || !isPlainKey(e)) return;
      // Overlays (palette, sheets, menus) handle their own keys
      if (s.paletteOpen || s.filesSheet || s.inspectorSheet || document.querySelector('[role="dialog"], [role="menu"]')) return;

      const tabIndex = ['1', '2', '3', '4'].indexOf(e.key);
      if (tabIndex >= 0) {
        e.preventDefault();
        setTab(INSPECTOR_TABS[tabIndex].value);
        showInspector();
        return;
      }
      switch (e.key) {
        case '/':
          e.preventDefault();
          setPaletteOpen(true);
          break;
        case '[':
          e.preventDefault();
          toggleLeft();
          break;
        case ']':
          e.preventDefault();
          toggleRight();
          break;
        case '-':
        case '_':
          canvasRef.current?.zoomOut();
          break;
        case '+':
        case '=':
          canvasRef.current?.zoomIn();
          break;
        case 'f':
        case 'F':
          canvasRef.current?.zoomToFit();
          break;
        case 'Escape':
          if (s.simulationMode) exitSimulation();
          else if (s.code) setCode(null);
          else if (s.selectedNode || s.selectedFilePath) {
            setSelectedNode(null);
            setSelectedFilePath(null);
            setHighlightedNodeIds(EMPTY_SET);
            setZoomToNodes(null);
          }
          break;
        default:
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [toggleLeft, toggleRight, showInspector]);

  // ---- Render: error / loading -------------------------------------------------
  const repoCrumb = (
    <span className="truncate font-cg-mono text-cg-sm text-cg-text">
      {owner}/{repo}
    </span>
  );

  if (error && errorCode === 'no_source') {
    return (
      <div className="flex h-dvh flex-col bg-cg-canvas font-cg-sans text-cg-text">
        <TopBarFrame repoLabel={repoCrumb} />
        <CenterMessage
          icon={<FileX size={24} strokeWidth={1.5} aria-hidden="true" className="mx-auto text-cg-tertiary" />}
          title={`No source files CodeGraph can read in ${owner}/${repo}`}
          body={String(error)}
          actions={<Button variant="primary" onClick={() => navigate('/')}>Analyze another repo</Button>}
        />
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex h-dvh flex-col bg-cg-canvas font-cg-sans text-cg-text">
        <TopBarFrame repoLabel={repoCrumb} />
        <CenterMessage
          icon={<TriangleAlert size={24} strokeWidth={1.5} aria-hidden="true" className="mx-auto text-cg-tertiary" />}
          title={`Couldn't analyze ${owner}/${repo}`}
          body={`${String(error).replace(/\.\s*$/, '')}. Check that the repository is public and has source files in a supported language, then try again.`}
          actions={
            <>
              <Button variant="primary" onClick={() => window.location.reload()}>
                Try again
              </Button>
              <Button onClick={() => navigate('/')}>Back to home</Button>
            </>
          }
        />
      </div>
    );
  }

  if (jobStatus === 'analyzing' || !graphData) {
    return (
      <div className="flex h-dvh flex-col bg-cg-canvas font-cg-sans text-cg-text">
        <TopBarFrame repoLabel={repoCrumb} />
        <div className="flex flex-1 items-center justify-center p-4">
          {jobStatus === 'analyzing' ? (
            <ProgressBar progress={progress} stage={stage} message={message} startedAt={startedAt} repo={`${owner}/${repo}`} />
          ) : (
            <p role="status" className="text-cg-sm text-cg-tertiary">
              Loading graph…
            </p>
          )}
        </div>
      </div>
    );
  }

  // ---- Render: app ------------------------------------------------------------
  const fileTree = (
    <FileTree
      graph={graphData}
      onFileSelect={handleFileSelect}
      onNodeSelect={(node) => {
        selectNode(node);
        if (isMobile) setFilesSheet(false);
      }}
      onSimulateFile={simulate}
      selectedFilePath={selectedFilePath}
      selectedNodeId={selectedNode?.id ?? null}
      dirColorMap={dirColorMap}
    />
  );

  const inspector = (
    <Inspector
      tab={tab}
      onTabChange={setTab}
      graph={graphData}
      analysis={analysis}
      analysisLoading={analysisLoading}
      selectedNode={selectedNode}
      offline={offline}
      simulationSource={simulationSource}
      onSelectNode={(node) => {
        selectNode(node);
        setZoomToNodes([node.id]);
      }}
      onViewSource={viewSource}
      onSimulate={simulate}
      onOpenSearch={() => setPaletteOpen(true)}
      onNodeHighlight={handleChatHighlight}
      onBlastRadiusChange={setBlastRadius}
      onSimulationModeChange={setSimulationMode}
      onAnalyzeOwn={() => navigate('/')}
      onRerun={offline ? undefined : rerun}
      onReloadGraph={offline ? undefined : reloadGraph}
      dirColorMap={dirColorMap}
      onDiagramNodeClick={handleDiagramNode}
    />
  );

  const canvasColumn = (
    <div className="relative flex h-full min-w-0 flex-col overflow-hidden">
      <div className="relative min-h-0 flex-1 overflow-hidden bg-cg-canvas">
        <GraphCanvas
          ref={canvasRef}
          graph={graphData}
          onNodeClick={(node) => {
            selectNode(node);
            if (isMobile && node) setInspectorSheet(true);
          }}
          selectedNodeId={selectedNode?.id ?? null}
          highlightedNodeIds={effectiveHighlights}
          chatHighlightedNodeIds={chatHighlightedNodeIds}
          zoomToNodes={zoomToNodes}
          dirColorMap={dirColorMap}
          blastRadius={blastRadius}
          simulationMode={simulationMode}
          onExitSimulation={exitSimulation}
          hullsVisible={hullsVisible}
          hiddenDirs={hiddenDirs}
          onZoom={(k) => zoomListener.current?.(k)}
        />

        {(notice || (isMobile && showSmallNote)) && (
          <div className="absolute inset-x-3 top-14 z-30 flex flex-col gap-2">
            {notice && (
              <p role="status" className="flex items-start gap-2 rounded-cg-control border border-cg-border bg-cg-overlay py-2 pl-3 pr-1 text-cg-sm text-cg-text shadow-cg-edge">
                <span className="flex-1">{notice}</span>
                <IconButton label="Dismiss" size="sm" tooltip={false} onClick={() => setNotice(null)}>
                  <X size={16} strokeWidth={1.5} aria-hidden="true" />
                </IconButton>
              </p>
            )}
            {isMobile && showSmallNote && (
              <p className="flex items-center gap-2 rounded-cg-control border border-cg-border bg-cg-overlay py-1 pl-3 pr-1 text-cg-sm text-cg-secondary shadow-cg-edge">
                <span className="flex-1">CodeGraph works best on a larger screen.</span>
                <IconButton
                  label="Dismiss"
                  size="sm"
                  tooltip={false}
                  onClick={() => {
                    setShowSmallNote(false);
                    writeStorage(SMALL_SCREEN_NOTE_KEY, true);
                  }}
                >
                  <X size={16} strokeWidth={1.5} aria-hidden="true" />
                </IconButton>
              </p>
            )}
          </div>
        )}

        <SegmentedControl
          label="Canvas view"
          options={CANVAS_VIEWS}
          value={canvasView}
          onChange={setCanvasView}
          className="absolute left-3 top-3 z-20"
        />
        {canvasView === 'architecture' && (
          <ArchitectureView
            graph={graphData}
            dirColorMap={dirColorMap}
            onNodeClick={handleDiagramNode}
            onRerun={offline ? undefined : rerun}
            rerunning={rerunning}
          />
        )}

        {!simulationMode && canvasView === 'graph' && (
          <GraphLegend
            graph={graphData}
            dirColorMap={dirColorMap}
            hullsVisible={hullsVisible}
            onHullsVisibleChange={setHullsVisible}
            hiddenDirs={hiddenDirs}
            onHiddenDirsChange={setHiddenDirs}
          />
        )}

        {code && (
          <CodeInspector
            filePath={code.file}
            focusLine={code.line}
            graph={graphData}
            selectedNodeId={selectedNode?.id ?? null}
            onClose={() => setCode(null)}
            onNodeClick={(node) => selectNode(node)}
            repo={`${owner}/${repo}`}
            commitSha={graphData?.commit_sha}
            offline={offline}
            onRerun={offline ? undefined : rerun}
          />
        )}
      </div>
      <StatusBar
        graph={graphData}
        zoomListener={zoomListener}
        onZoomIn={() => canvasRef.current?.zoomIn()}
        onZoomOut={() => canvasRef.current?.zoomOut()}
        onFit={() => canvasRef.current?.zoomToFit()}
      />
    </div>
  );

  return (
    <div className="relative flex h-dvh flex-col overflow-hidden bg-cg-canvas font-cg-sans text-cg-text">
      <AppTopBar
        owner={owner}
        repo={repo}
        commitSha={graphData.commit_sha}
        offline={offline}
        isMobile={isMobile}
        leftOpen={isMobile ? filesSheet : leftOpen}
        rightOpen={isMobile ? inspectorSheet : rightOpen}
        onToggleLeft={toggleLeft}
        onToggleRight={toggleRight}
        onOpenSearch={() => setPaletteOpen(true)}
        onRerun={rerun}
        rerunning={rerunning}
        onNew={() => navigate('/')}
      />

      {isMobile ? (
        <>
          <div className="min-h-0 flex-1">{canvasColumn}</div>
          <Dialog open={filesSheet} onOpenChange={setFilesSheet}>
            <DialogContent side="left" bare title="Files">
              {fileTree}
            </DialogContent>
          </Dialog>
          <Dialog open={inspectorSheet} onOpenChange={setInspectorSheet}>
            <DialogContent side="right" bare title="Inspector">
              {inspector}
            </DialogContent>
          </Dialog>
        </>
      ) : (
        <PanelGroup direction="horizontal" autoSaveId="codegraph:app-layout" storage={safePanelStorage} className="min-h-0 flex-1">
          <Panel
            ref={leftPanelRef}
            id="files"
            order={1}
            collapsible
            collapsedSize={0}
            {...sizes.left}
            onCollapse={() => setLeftOpen(false)}
            onExpand={() => setLeftOpen(true)}
            className="relative"
          >
            {fileTree}
          </Panel>
          <ResizeHandle label="Resize file tree" />
          <Panel id="canvas" order={2} minSize={25} className="relative">
            {canvasColumn}
          </Panel>
          <ResizeHandle label="Resize inspector" />
          <Panel
            ref={rightPanelRef}
            id="inspector"
            order={3}
            collapsible
            collapsedSize={0}
            {...sizes.right}
            onCollapse={() => setRightOpen(false)}
            onExpand={() => setRightOpen(true)}
            className="relative"
          >
            {inspector}
          </Panel>
        </PanelGroup>
      )}

      <CommandPalette open={paletteOpen} onOpenChange={setPaletteOpen} graph={graphData} recentIds={recentIds} onSelect={selectFromPalette} />
    </div>
  );
}
