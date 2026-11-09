import { HeartPulse, Info, MessageSquare, Zap } from 'lucide-react';
import { Tabs, TabsContent, TabsList, TabsTrigger, Tooltip } from '../../ui';
import ChatSidebar from '../ChatSidebar';
import HealthPanel from '../HealthPanel';
import SimulatorPanel from '../SimulatorPanel';
import NodeDetails from './NodeDetails';

export const INSPECTOR_TABS = [
  { value: 'details', label: 'Details', Icon: Info },
  { value: 'chat', label: 'Chat', Icon: MessageSquare },
  { value: 'health', label: 'Health', Icon: HeartPulse },
  { value: 'impact', label: 'Impact', Icon: Zap },
];

/**
 * Right-hand inspector. All four tabs stay mounted (hidden when inactive) so chat
 * history, filters and each tab's scroll position survive tab switches.
 */
export default function Inspector({
  tab,
  onTabChange,
  graph,
  analysis,
  analysisLoading,
  selectedNode,
  offline,
  simulationSource,
  onSelectNode,
  onViewSource,
  onSimulate,
  onOpenSearch,
  onNodeHighlight,
  onBlastRadiusChange,
  onSimulationModeChange,
  onAnalyzeOwn,
}) {
  return (
    <Tabs value={tab} onValueChange={onTabChange} className="relative flex h-full min-h-0 flex-col overflow-hidden bg-cg-raised font-cg-sans">
      <TabsList aria-label="Inspector" className="h-10 shrink-0 gap-0 px-1">
        {INSPECTOR_TABS.map(({ value, label, Icon }, i) => (
          <Tooltip key={value} content={<span>{label} · press {i + 1}</span>}>
            <TabsTrigger value={value} className="h-10 gap-1.5 px-2.5" aria-keyshortcuts={String(i + 1)}>
              <Icon size={16} strokeWidth={1.5} aria-hidden="true" />
              {label}
            </TabsTrigger>
          </Tooltip>
        ))}
      </TabsList>

      <TabsContent forceMount value="details" className="relative min-h-0 flex-1 overflow-y-auto pt-0 data-[state=inactive]:hidden">
        <NodeDetails
          node={selectedNode}
          graph={graph}
          onSelectNode={onSelectNode}
          onViewSource={onViewSource}
          onSimulate={onSimulate}
          onOpenSearch={onOpenSearch}
        />
      </TabsContent>
      <TabsContent forceMount value="chat" className="relative min-h-0 flex-1 overflow-hidden pt-0 data-[state=inactive]:hidden">
        <ChatSidebar graph={graph} offline={offline} onNodeSelect={onSelectNode} onNodeHighlight={onNodeHighlight} onAnalyzeOwn={onAnalyzeOwn} />
      </TabsContent>
      <TabsContent forceMount value="health" className="relative min-h-0 flex-1 overflow-y-auto pt-0 data-[state=inactive]:hidden">
        <HealthPanel analysis={analysis} graph={graph} isLoading={analysisLoading} onNodeSelect={onSelectNode} onViewSource={onViewSource} />
      </TabsContent>
      <TabsContent forceMount value="impact" className="relative min-h-0 flex-1 overflow-y-auto pt-0 data-[state=inactive]:hidden">
        <SimulatorPanel
          graph={graph}
          offline={offline}
          simulationSourceFile={simulationSource}
          onBlastRadiusChange={onBlastRadiusChange}
          onSimulationModeChange={onSimulationModeChange}
          onNodeHighlight={onNodeHighlight}
          onNodeNavigate={onSelectNode}
        />
      </TabsContent>
    </Tabs>
  );
}
