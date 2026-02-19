import { useState, useEffect, useCallback } from 'react';
import type { PipelineState } from '../hooks/usePipeline';
import type { MatchedLine } from '../bridge/types';
import { getMatchedLines, getPiiMappings } from '../bridge/commands';
import { useChartData } from '../hooks/useChartData';
import VarInspector from './VarInspector';
import ProcessorChart from './ProcessorChart';
import PiiTestPane from './PiiTestPane';

interface Props {
  pipeline: PipelineState;
  sessionId: string;
  onViewProcessor: (processorId: string) => void;
  onJumpToLine?: (lineNum: number) => void;
}

type Tab = 'vars' | 'charts' | 'matches' | 'test';

export default function ProcessorDashboard({
  pipeline,
  sessionId,
  onJumpToLine,
}: Props) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>('vars');
  const [matchedLines, setMatchedLines] = useState<MatchedLine[]>([]);
  const [matchesLoading, setMatchesLoading] = useState(false);
  const [matchSearch, setMatchSearch] = useState('');
  const [piiMappings, setPiiMappings] = useState<Record<string, string>>({});
  const { fetchCharts, getProcessorCharts, loading: chartsLoading } = useChartData();

  const activeProcessors = Array.from(pipeline.activeProcessorIds)
    .map((id) => pipeline.processors.find((p) => p.id === id))
    .filter(Boolean);

  const selected = selectedId ?? activeProcessors[0]?.id ?? null;

  // Increments after every completed pipeline run — used as refreshKey for
  // VarInspector and the matches list so they re-fetch automatically.
  const runCount = pipeline.runCount;

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

  useEffect(() => {
    if (selected === '__pii_anonymizer' && tab === 'vars' && sessionId && runCount > 0) {
      getPiiMappings(sessionId)
        .then(setPiiMappings)
        .catch(() => setPiiMappings({}));
    }
  }, [selected, tab, sessionId, runCount]);

  if (activeProcessors.length === 0) {
    return (
      <div className="proc-dashboard-empty">
        No active processors. Select processors in the panel and run the pipeline.
      </div>
    );
  }

  const processorCharts = selected ? getProcessorCharts(sessionId, selected) : [];

  const filteredLines = matchSearch.trim()
    ? matchedLines.filter((l) => l.raw.toLowerCase().includes(matchSearch.toLowerCase()))
    : matchedLines;

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
            {selected === '__pii_anonymizer' && (
              <button
                className={`proc-subtab${tab === 'test' ? ' proc-subtab-active' : ''}`}
                onClick={() => setTab('test')}
              >
                Test
              </button>
            )}
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
              {selected === '__pii_anonymizer' && (
                <div className="pii-mapping-section">
                  <div className="pii-mapping-title">Token Mapping</div>
                  {Object.keys(piiMappings).length === 0 ? (
                    <div className="proc-dash-log-hint">
                      Run the pipeline with "Anonymize PII" enabled to see token mappings.
                    </div>
                  ) : (
                    <table className="pii-mapping-table">
                      <thead>
                        <tr><th>Token</th><th>Original Value</th></tr>
                      </thead>
                      <tbody>
                        {Object.entries(piiMappings).map(([token, original]) => (
                          <tr key={token}>
                            <td><code className="pii-token-code">{token}</code></td>
                            <td className="pii-original-value">{original}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                </div>
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

          {tab === 'test' && (
            <div className="proc-dash-test">
              <PiiTestPane />
            </div>
          )}

          {tab === 'matches' && (
            <div className="proc-matches">
              {matchedLines.length > 0 && (
                <div className="proc-matches-search-bar">
                  <input
                    className="proc-matches-search"
                    type="text"
                    placeholder="Filter matches…"
                    value={matchSearch}
                    onChange={(e) => setMatchSearch(e.target.value)}
                    spellCheck={false}
                  />
                  {matchSearch.trim() && (
                    <span className="proc-matches-count">
                      {filteredLines.length} / {matchedLines.length}
                    </span>
                  )}
                </div>
              )}
              {matchesLoading && <div className="proc-dash-loading">Loading…</div>}
              {!matchesLoading && matchedLines.length === 0 && (
                <div className="proc-dash-log-hint">
                  No matched lines. Run the pipeline first.
                </div>
              )}
              {!matchesLoading && matchedLines.length > 0 && (
                <div className="proc-matches-list">
                  {filteredLines.length === 0 ? (
                    <div className="proc-dash-log-hint">No matches for "{matchSearch}"</div>
                  ) : (
                    filteredLines.map((line) => (
                      <div
                        key={line.lineNum}
                        className="proc-match-row"
                        onClick={() => onJumpToLine?.(line.lineNum)}
                        title={`Jump to line ${line.lineNum}`}
                      >
                        <span className="proc-match-linenum">{line.lineNum + 1}</span>
                        <span className="proc-match-raw">{line.raw}</span>
                      </div>
                    ))
                  )}
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
