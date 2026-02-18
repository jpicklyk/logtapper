import { useState } from 'react';
import type { PipelineState } from '../hooks/usePipeline';
import VarInspector from './VarInspector';

interface Props {
  pipeline: PipelineState;
  sessionId: string;
  onViewProcessor: (processorId: string) => void;
}

type Tab = 'vars' | 'log';

export default function ProcessorDashboard({ pipeline, sessionId, onViewProcessor }: Props) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>('vars');

  const activeProcessors = Array.from(pipeline.activeProcessorIds)
    .map((id) => pipeline.processors.find((p) => p.id === id))
    .filter(Boolean);

  if (activeProcessors.length === 0) {
    return (
      <div className="proc-dashboard-empty">
        No active processors. Select processors in the panel and run the pipeline.
      </div>
    );
  }

  const selected = selectedId ?? activeProcessors[0]?.id ?? null;

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
          {/* Sub-tabs: vars | log view */}
          <div className="proc-dash-subtabs">
            <button
              className={`proc-subtab${tab === 'vars' ? ' proc-subtab-active' : ''}`}
              onClick={() => setTab('vars')}
            >
              Variables
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
