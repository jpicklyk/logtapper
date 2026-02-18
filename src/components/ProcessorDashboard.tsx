import { useState, useEffect, useCallback } from 'react';
import type { PipelineState } from '../hooks/usePipeline';
import type { MatchedLine } from '../bridge/types';
import { getMatchedLines } from '../bridge/commands';
import { useChartData } from '../hooks/useChartData';
import VarInspector from './VarInspector';
import ProcessorChart from './ProcessorChart';

interface Props {
  pipeline: PipelineState;
  sessionId: string;
  onViewProcessor: (processorId: string) => void;
  onJumpToLine?: (lineNum: number) => void;
}

type Tab = 'vars' | 'charts' | 'matches';

export default function ProcessorDashboard({
  pipeline,
  sessionId,
  onJumpToLine,
}: Props) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>('vars');
  const [matchedLines, setMatchedLines] = useState<MatchedLine[]>([]);
  const [matchesLoading, setMatchesLoading] = useState(false);
  const { fetchCharts, getProcessorCharts, loading: chartsLoading } = useChartData();

  const activeProcessors = Array.from(pipeline.activeProcessorIds)
    .map((id) => pipeline.processors.find((p) => p.id === id))
    .filter(Boolean);

  const selected = selectedId ?? activeProcessors[0]?.id ?? null;

  // Count of completed runs — used as refreshKey for VarInspector so it
  // re-fetches vars automatically after each pipeline run.
  const runCount = pipeline.lastResults.length;

  // Fetch charts when switching to charts tab or when selected changes.
  useEffect(() => {
    if (tab === 'charts' && selected && sessionId) {
      fetchCharts(sessionId, selected);
    }
  }, [tab, selected, sessionId, fetchCharts]);

  // Fetch matched lines when switching to matches tab, or when a new run
  // completes while the matches tab is already open.
  const fetchMatches = useCallback(async (sid: string, pid: string) => {
    setMatchesLoading(true);
    try {
      const lines = await getMatchedLines(sid, pid);
      setMatchedLines(lines);
    } catch {
      setMatchedLines([]);
    } finally {
      setMatchesLoading(false);
    }
  }, []);

  useEffect(() => {
    if (tab === 'matches' && selected && sessionId) {
      fetchMatches(sessionId, selected);
    }
  }, [tab, selected, sessionId, runCount, fetchMatches]);

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
              className={`proc-subtab${tab === 'matches' ? ' proc-subtab-active' : ''}`}
              onClick={() => setTab('matches')}
            >
              Matches
            </button>
          </div>

          {tab === 'vars' && (
            <div className="proc-dash-vars">
              {runCount === 0 ? (
                <div className="proc-dash-log-hint">Run the pipeline to see variable values.</div>
              ) : (
                <VarInspector
                  sessionId={sessionId}
                  processorId={selected}
                  getVars={pipeline.getVars}
                  refreshKey={runCount}
                />
              )}
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

          {tab === 'matches' && (
            <div className="proc-matches">
              {matchesLoading && <div className="proc-dash-loading">Loading…</div>}
              {!matchesLoading && matchedLines.length === 0 && (
                <div className="proc-dash-log-hint">
                  No matched lines. Run the pipeline first.
                </div>
              )}
              {!matchesLoading && matchedLines.length > 0 && (
                <div className="proc-matches-list">
                  {matchedLines.map((line) => (
                    <div
                      key={line.lineNum}
                      className="proc-match-row"
                      onClick={() => onJumpToLine?.(line.lineNum)}
                      title={`Jump to line ${line.lineNum}`}
                    >
                      <span className="proc-match-linenum">{line.lineNum + 1}</span>
                      <span className="proc-match-raw">{line.raw}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
