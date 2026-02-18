import { useState, useEffect } from 'react';
import type { PipelineState } from '../hooks/usePipeline';
import { useChartData } from '../hooks/useChartData';
import VarInspector from './VarInspector';
import ProcessorChart from './ProcessorChart';

interface Props {
  pipeline: PipelineState;
  sessionId: string;
  onViewProcessor: (processorId: string) => void;
  onJumpToLine?: (lineNum: number) => void;
}

type Tab = 'vars' | 'charts' | 'log';

export default function ProcessorDashboard({
  pipeline,
  sessionId,
  onViewProcessor,
  onJumpToLine,
}: Props) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>('vars');
  const { fetchCharts, getProcessorCharts, loading: chartsLoading } = useChartData();

  const activeProcessors = Array.from(pipeline.activeProcessorIds)
    .map((id) => pipeline.processors.find((p) => p.id === id))
    .filter(Boolean);

  const selected = selectedId ?? activeProcessors[0]?.id ?? null;

  // Fetch charts when switching to charts tab or when selected changes
  useEffect(() => {
    if (tab === 'charts' && selected && sessionId) {
      fetchCharts(sessionId, selected);
    }
  }, [tab, selected, sessionId, fetchCharts]);

  if (activeProcessors.length === 0) {
    return (
      <div className="proc-dashboard-empty">
        No active processors. Select processors in the panel and run the pipeline.
      </div>
    );
  }

  const processorCharts = selected ? getProcessorCharts(sessionId, selected) : [];

  return (
    <div className="proc-dashboard">
      {/* Processor tabs */}
      <div className="proc-dash-tabs">
        {activeProcessors.map((p) => (
          <button
            key={p!.id}
            className={`proc-dash-tab${selected === p!.id ? ' proc-dash-tab-active' : ''}`}
            onClick={() => setSelectedId(p!.id)}
          >
            {p!.name}
          </button>
        ))}
      </div>

      {selected && (
        <div className="proc-dash-content">
          {/* Sub-tabs */}
          <div className="proc-dash-subtabs">
            <button
              className={`proc-subtab${tab === 'vars' ? ' proc-subtab-active' : ''}`}
              onClick={() => setTab('vars')}
            >
              Variables
            </button>
            <button
              className={`proc-subtab${tab === 'charts' ? ' proc-subtab-active' : ''}`}
              onClick={() => setTab('charts')}
            >
              Charts
            </button>
            <button
              className={`proc-subtab${tab === 'log' ? ' proc-subtab-active' : ''}`}
              onClick={() => { setTab('log'); onViewProcessor(selected); }}
            >
              Log View
            </button>
          </div>

          {tab === 'vars' && (
            <div className="proc-dash-vars">
              <VarInspector
                sessionId={sessionId}
                processorId={selected}
                getVars={pipeline.getVars}
              />
            </div>
          )}

          {tab === 'charts' && (
            <div className="proc-dash-charts">
              {chartsLoading && <div className="proc-dash-loading">Loading charts…</div>}
              {!chartsLoading && processorCharts.length === 0 && (
                <div className="proc-dash-log-hint">
                  No charts declared in this processor's output stage. Run the pipeline first.
                </div>
              )}
              {processorCharts.map((c) => (
                <ProcessorChart
                  key={c.id}
                  chart={c}
                  onPointClick={onJumpToLine}
                />
              ))}
            </div>
          )}

          {tab === 'log' && (
            <div className="proc-dash-log-hint">
              Log view is active in the main viewer panel.
            </div>
          )}
        </div>
      )}
    </div>
  );
}
