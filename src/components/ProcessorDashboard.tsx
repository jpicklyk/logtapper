import { useState, useEffect, useCallback } from 'react';
import type { PipelineState } from '../hooks/usePipeline';
import type { MatchedLine, VarMeta } from '../bridge/types';
import { getMatchedLines, getPiiMappings } from '../bridge/commands';
import { useChartData } from '../hooks/useChartData';
import ProcessorChart from './ProcessorChart';
import PiiTestPane from './PiiTestPane';

interface Props {
  pipeline: PipelineState;
  sessionId: string;
  onViewProcessor: (processorId: string) => void;
  onJumpToLine?: (lineNum: number) => void;
}

// ── Var rendering ─────────────────────────────────────────────────────────────

function isNumeric(v: unknown): v is number {
  return typeof v === 'number' && isFinite(v);
}

function isRankedObject(v: unknown): v is Record<string, number> {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return false;
  return Object.values(v as Record<string, unknown>).every(isNumeric);
}

function formatNumber(n: number): string {
  if (Number.isInteger(n)) return n.toLocaleString();
  return n.toLocaleString(undefined, { maximumFractionDigits: 2 });
}

function snakeToTitle(s: string): string {
  return s.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

interface VarGroup {
  scalars: Array<{ name: string; value: number }>;
  strings: Array<{ name: string; value: string }>;
  ranked: Array<{ name: string; value: Record<string, number> }>;
  tables: Array<{ name: string; value: Record<string, unknown>[] }>;
  other: Array<{ name: string; value: unknown }>;
}

function groupVars(vars: Record<string, unknown>): VarGroup {
  const g: VarGroup = { scalars: [], strings: [], ranked: [], tables: [], other: [] };
  for (const [name, value] of Object.entries(vars)) {
    if (isNumeric(value)) {
      g.scalars.push({ name, value });
    } else if (typeof value === 'string') {
      g.strings.push({ name, value });
    } else if (isRankedObject(value)) {
      g.ranked.push({ name, value });
    } else if (Array.isArray(value) && value.length > 0 && typeof value[0] === 'object') {
      g.tables.push({ name, value: value as Record<string, unknown>[] });
    } else {
      g.other.push({ name, value });
    }
  }
  return g;
}

// ── Sub-components ────────────────────────────────────────────────────────────

function StatCard({ label, value }: { label: string; value: number }) {
  return (
    <div className="dash-stat-card">
      <span className="dash-stat-value">{formatNumber(value)}</span>
      <span className="dash-stat-label">{snakeToTitle(label)}</span>
    </div>
  );
}

function RankedList({ name, label, value }: { name: string; label?: string; value: Record<string, number> }) {
  const sorted = Object.entries(value).sort((a, b) => b[1] - a[1]).slice(0, 15);
  const max = sorted[0]?.[1] ?? 1;
  return (
    <div className="dash-section">
      <div className="dash-section-label">{label ?? snakeToTitle(name)}</div>
      <div className="dash-ranked-list">
        {sorted.map(([k, v]) => (
          <div key={k} className="dash-ranked-row">
            <span className="dash-ranked-key" title={k}>{k}</span>
            <div className="dash-ranked-bar-wrap">
              <div className="dash-ranked-bar" style={{ width: `${(v / max) * 100}%` }} />
            </div>
            <span className="dash-ranked-val">{formatNumber(v)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function DataTable({ name, label, value }: { name: string; label?: string; value: Record<string, unknown>[] }) {
  const keys = Object.keys(value[0] ?? {});
  return (
    <div className="dash-section">
      <div className="dash-section-label">{label ?? snakeToTitle(name)}</div>
      <div className="dash-table-wrap">
        <table className="dash-data-table">
          <thead>
            <tr>{keys.map((k) => <th key={k}>{k}</th>)}</tr>
          </thead>
          <tbody>
            {value.slice(0, 100).map((row, i) => (
              <tr key={i}>
                {keys.map((k) => <td key={k}>{String(row[k] ?? '')}</td>)}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

export default function ProcessorDashboard({
  pipeline,
  sessionId,
  onJumpToLine,
}: Props) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [vars, setVars] = useState<Record<string, unknown> | null>(null);
  const [piiMappings, setPiiMappings] = useState<Record<string, string>>({});
  const [showMatches, setShowMatches] = useState(false);
  const [matchedLines, setMatchedLines] = useState<MatchedLine[]>([]);
  const [matchesLoading, setMatchesLoading] = useState(false);
  const [matchSearch, setMatchSearch] = useState('');
  const { fetchCharts, getProcessorCharts, loading: chartsLoading } = useChartData();

  const runCount = pipeline.runCount;

  const activeProcessors = Array.from(pipeline.activeProcessorIds)
    .map((id) => pipeline.processors.find((p) => p.id === id))
    .filter(Boolean);

  const selected = selectedId ?? activeProcessors[0]?.id ?? null;
  const selectedProc = activeProcessors.find((p) => p!.id === selected);

  const getSummary = (id: string) =>
    pipeline.lastResults.find((r) => r.processorId === id);

  // Fetch vars when selection or run count changes.
  useEffect(() => {
    if (!selected || !sessionId || runCount === 0) { setVars(null); return; }
    pipeline.getVars(sessionId, selected)
      .then(setVars)
      .catch(() => setVars(null));
  }, [selected, sessionId, runCount]); // eslint-disable-line react-hooks/exhaustive-deps

  // Fetch charts when selection or run count changes.
  useEffect(() => {
    if (selected && sessionId && runCount > 0) {
      fetchCharts(sessionId, selected);
    }
  }, [selected, sessionId, runCount, fetchCharts]);

  // PII mappings.
  useEffect(() => {
    if (selected === '__pii_anonymizer' && sessionId && runCount > 0) {
      getPiiMappings(sessionId).then(setPiiMappings).catch(() => setPiiMappings({}));
    }
  }, [selected, sessionId, runCount]);

  // Fetch matches when the section is opened.
  const fetchMatches = useCallback(async () => {
    if (!selected || !sessionId) return;
    setMatchesLoading(true);
    try {
      setMatchedLines(await getMatchedLines(sessionId, selected));
    } catch {
      setMatchedLines([]);
    } finally {
      setMatchesLoading(false);
    }
  }, [selected, sessionId]);

  const handleToggleMatches = useCallback(() => {
    if (!showMatches) fetchMatches();
    setShowMatches((v) => !v);
    setMatchSearch('');
  }, [showMatches, fetchMatches]);

  // Re-fetch matches if already open and pipeline re-ran.
  useEffect(() => {
    if (showMatches && runCount > 0) fetchMatches();
  }, [runCount]); // eslint-disable-line react-hooks/exhaustive-deps

  if (activeProcessors.length === 0) {
    return (
      <div className="dash-empty">
        <span className="dash-empty-icon">⚙</span>
        <span>No active processors.</span>
        <span className="dash-empty-sub">Add processors to the pipeline chain and run it.</span>
      </div>
    );
  }

  const processorCharts = selected ? getProcessorCharts(sessionId, selected) : [];
  const varGroups = vars ? groupVars(vars) : null;
  const summary = selected ? getSummary(selected) : null;

  // Metadata-driven rendering: vars declared with display:true, in YAML order.
  const displayMeta: VarMeta[] = (selectedProc?.varsMeta ?? []).filter((m) => m.display);
  const hasVarMeta = displayMeta.length > 0;

  // When metadata is available, split scalars (stat-grid) from everything else.
  const metaScalars = hasVarMeta && vars
    ? displayMeta.filter((m) => isNumeric(vars[m.name]))
    : [];
  const metaNonScalars = hasVarMeta && vars
    ? displayMeta.filter((m) => !isNumeric(vars[m.name]))
    : [];
  const filteredLines = matchSearch.trim()
    ? matchedLines.filter((l) => l.raw.toLowerCase().includes(matchSearch.toLowerCase()))
    : matchedLines;

  const totalMatches = pipeline.lastResults.reduce((n, r) => n + r.matchedLines, 0);

  return (
    <div className="dash-layout">

      {/* ── Left: processor list ── */}
      <div className="dash-proc-list">
        <div className="dash-proc-list-header">
          {runCount > 0
            ? `${activeProcessors.length} processor${activeProcessors.length !== 1 ? 's' : ''} · ${totalMatches.toLocaleString()} matches`
            : `${activeProcessors.length} processor${activeProcessors.length !== 1 ? 's' : ''}`}
        </div>
        {activeProcessors.map((p) => {
          const s = getSummary(p!.id);
          const isSelected = p!.id === selected;
          return (
            <button
              key={p!.id}
              className={`dash-proc-card${isSelected ? ' dash-proc-card--active' : ''}`}
              onClick={() => { setSelectedId(p!.id); setShowMatches(false); }}
            >
              <div className="dash-proc-card-name">{p!.name}</div>
              {s ? (
                <div className="dash-proc-card-stats">
                  <span>{s.matchedLines.toLocaleString()} matches</span>
                  {s.emissionCount > 0 && (
                    <span className="dash-proc-card-emissions">· {s.emissionCount.toLocaleString()} events</span>
                  )}
                </div>
              ) : (
                <div className="dash-proc-card-stats dash-proc-card-stats--dim">not run</div>
              )}
            </button>
          );
        })}
      </div>

      {/* ── Right: detail panel ── */}
      {selected && (
        <div className="dash-detail">

          {/* Header */}
          <div className="dash-detail-header">
            <div className="dash-detail-title">
              {selectedProc?.name}
              {selectedProc && (
                <span className={`dash-type-badge dash-type-badge--${selectedProc.processorType}`}>
                  {selectedProc.processorType.replace('_', ' ')}
                </span>
              )}
            </div>
            {summary && runCount > 0 && (
              <div className="dash-detail-meta">
                <span className="dash-meta-chip">{summary.matchedLines.toLocaleString()} matched</span>
                {summary.emissionCount > 0 && (
                  <span className="dash-meta-chip dash-meta-chip--emit">{summary.emissionCount.toLocaleString()} events</span>
                )}
              </div>
            )}
            {selectedProc?.description && (
              <p className="dash-detail-desc">{selectedProc.description}</p>
            )}
          </div>

          {runCount === 0 ? (
            <div className="dash-hint">Run the pipeline to see results.</div>
          ) : (
            <div className="dash-detail-body">

              {/* ── Metadata-driven var rendering (display:true vars, YAML order) ── */}
              {hasVarMeta && vars && metaScalars.length > 0 && (
                <div className="dash-stat-grid">
                  {metaScalars.map((m) => (
                    <StatCard key={m.name} label={m.label} value={vars[m.name] as number} />
                  ))}
                </div>
              )}

              {hasVarMeta && vars && metaNonScalars.map((m) => {
                const value = vars[m.name];
                if (typeof value === 'string') {
                  return (
                    <div key={m.name} className="dash-section">
                      <div className="dash-string-list">
                        <div className="dash-string-row">
                          <span className="dash-string-key">{m.label}</span>
                          <span className="dash-string-val">{value || '—'}</span>
                        </div>
                      </div>
                    </div>
                  );
                }
                // display_as: table on a ranked object → DataTable rows (using columns as key/value names)
                if (m.displayAs === 'table' && isRankedObject(value)) {
                  const colKey = m.columns[0] ?? 'key';
                  const colVal = m.columns[1] ?? 'count';
                  const rows = Object.entries(value as Record<string, number>)
                    .sort((a, b) => b[1] - a[1])
                    .map(([k, v]) => ({ [colKey]: k, [colVal]: v }));
                  return <DataTable key={m.name} name={m.name} label={m.label} value={rows} />;
                }
                if (Array.isArray(value) && value.length > 0 && typeof value[0] === 'object') {
                  return <DataTable key={m.name} name={m.name} label={m.label} value={value as Record<string, unknown>[]} />;
                }
                if (isRankedObject(value)) {
                  return <RankedList key={m.name} name={m.name} label={m.label} value={value as Record<string, number>} />;
                }
                return null;
              })}

              {/* ── Fallback: type-inferred rendering (no var declarations) ── */}
              {!hasVarMeta && varGroups && varGroups.scalars.length > 0 && (
                <div className="dash-stat-grid">
                  {varGroups.scalars.map(({ name, value }) => (
                    <StatCard key={name} label={name} value={value} />
                  ))}
                </div>
              )}

              {!hasVarMeta && varGroups && varGroups.strings.length > 0 && (
                <div className="dash-section">
                  <div className="dash-section-label">Values</div>
                  <div className="dash-string-list">
                    {varGroups.strings.map(({ name, value }) => (
                      <div key={name} className="dash-string-row">
                        <span className="dash-string-key">{snakeToTitle(name)}</span>
                        <span className="dash-string-val">{value || '—'}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {!hasVarMeta && varGroups && varGroups.ranked.map(({ name, value }) => (
                <RankedList key={name} name={name} value={value} />
              ))}

              {!hasVarMeta && varGroups && varGroups.tables.map(({ name, value }) => (
                <DataTable key={name} name={name} value={value} />
              ))}

              {/* Charts */}
              {(processorCharts.length > 0 || chartsLoading) && (
                <div className="dash-section">
                  <div className="dash-section-label">Charts</div>
                  {chartsLoading && <div className="dash-hint">Loading…</div>}
                  {processorCharts.map((c) => (
                    <ProcessorChart key={c.id} chart={c} onPointClick={onJumpToLine} />
                  ))}
                </div>
              )}

              {/* PII token mapping */}
              {selected === '__pii_anonymizer' && (
                <div className="dash-section">
                  <div className="dash-section-label">Token Mapping</div>
                  {Object.keys(piiMappings).length === 0 ? (
                    <div className="dash-hint">No token mappings yet.</div>
                  ) : (
                    <div className="dash-table-wrap">
                      <table className="dash-data-table">
                        <thead><tr><th>Token</th><th>Original</th></tr></thead>
                        <tbody>
                          {Object.entries(piiMappings).map(([token, original]) => (
                            <tr key={token}>
                              <td><code>{token}</code></td>
                              <td>{original}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                  <PiiTestPane />
                </div>
              )}

              {/* Matches section (collapsible) */}
              <div className="dash-section dash-section--matches">
                <button className="dash-matches-toggle" onClick={handleToggleMatches}>
                  <span className="dash-matches-toggle-arrow">{showMatches ? '▼' : '▶'}</span>
                  <span className="dash-section-label">
                    Matched Lines
                    {summary && (
                      <span className="dash-meta-chip" style={{ marginLeft: 8 }}>
                        {summary.matchedLines.toLocaleString()}
                      </span>
                    )}
                  </span>
                </button>

                {showMatches && (
                  <div className="dash-matches-body">
                    {matchedLines.length > 0 && (
                      <div className="dash-matches-search-row">
                        <input
                          className="dash-matches-search"
                          type="text"
                          placeholder="Filter…"
                          value={matchSearch}
                          onChange={(e) => setMatchSearch(e.target.value)}
                          spellCheck={false}
                        />
                        {matchSearch.trim() && (
                          <span className="dash-matches-count">
                            {filteredLines.length} / {matchedLines.length}
                          </span>
                        )}
                      </div>
                    )}
                    {matchesLoading && <div className="dash-hint">Loading…</div>}
                    {!matchesLoading && filteredLines.map((line) => (
                      <div
                        key={line.lineNum}
                        className="dash-match-row"
                        onClick={() => onJumpToLine?.(line.lineNum)}
                        title={`Jump to line ${line.lineNum}`}
                      >
                        <span className="dash-match-num">{line.lineNum + 1}</span>
                        <span className="dash-match-raw">{line.raw}</span>
                      </div>
                    ))}
                    {!matchesLoading && matchedLines.length === 0 && (
                      <div className="dash-hint">No matched lines.</div>
                    )}
                  </div>
                )}
              </div>

            </div>
          )}
        </div>
      )}
    </div>
  );
}
