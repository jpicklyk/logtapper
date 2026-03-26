import React, { useState, useEffect, useCallback, useMemo } from 'react';
import type { PipelineRunSummary, MatchedLine, VarMeta, StateTransition, StateSnapshot, CorrelatorResult } from '../../bridge/types';
import { getMatchedLines, getPiiMappings, getStateTransitions, getStateAtLine, getCorrelatorEvents } from '../../bridge/commands';
import {
  useSession,
  useProcessors,
  useActiveProcessorIds,
  usePipelineResults,
  useViewerActions,
} from '../../context';
import { usePipeline, useChartData } from '../../hooks';
import styles from './ProcessorDashboard.module.css';

// ── Var rendering helpers ────────────────────────────────────────────────────

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

// ── Sub-components ───────────────────────────────────────────────────────────

const StatCard = React.memo(function StatCard({ label, value }: { label: string; value: number }) {
  return (
    <div className={styles.statCard}>
      <span className={styles.statValue}>{formatNumber(value)}</span>
      <span className={styles.statLabel}>{snakeToTitle(label)}</span>
    </div>
  );
});

const RankedList = React.memo(function RankedList({
  name,
  label,
  value,
}: {
  name: string;
  label?: string;
  value: Record<string, number>;
}) {
  const sorted = Object.entries(value)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 15);
  const max = sorted[0]?.[1] ?? 1;
  return (
    <div className={styles.section}>
      <div className={styles.sectionLabel}>{label ?? snakeToTitle(name)}</div>
      <div className={styles.rankedList}>
        {sorted.map(([k, v]) => (
          <div key={k} className={styles.rankedRow}>
            <span className={styles.rankedKey} title={k}>
              {k}
            </span>
            <div className={styles.rankedBarWrap}>
              <div
                className={styles.rankedBar}
                style={{ width: `${(v / max) * 100}%` }}
              />
            </div>
            <span className={styles.rankedVal}>{formatNumber(v)}</span>
          </div>
        ))}
      </div>
    </div>
  );
});

// Detect "value | description" pattern used by annotated map vars (e.g. resolver experiments).
// Returns null if the separator is absent so normal rendering is used.
function splitValueDesc(raw: string): { value: string; desc: string } | null {
  const idx = raw.indexOf(' | ');
  if (idx === -1) return null;
  return { value: raw.slice(0, idx), desc: raw.slice(idx + 3) };
}

const DataTable = React.memo(function DataTable({
  name,
  label,
  value,
}: {
  name: string;
  label?: string;
  value: Record<string, unknown>[];
}) {
  const keys = Object.keys(value[0] ?? {});

  // Check once whether any cell uses the annotated "val | desc" format.
  const hasAnnotated = value.some((row) =>
    Object.values(row).some((v) => String(v ?? '').includes(' | ')),
  );

  return (
    <div className={styles.section}>
      <div className={styles.sectionLabel}>{label ?? snakeToTitle(name)}</div>
      <div className={styles.tableWrap}>
        <table className={styles.dataTable}>
          <thead>
            <tr>
              {keys.map((k) => (
                <th key={k}>{k}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {value.slice(0, 100).map((row, i) => (
              <tr key={i}>
                {keys.map((k, ki) => {
                  const raw = String(row[k] ?? '');
                  const split = hasAnnotated ? splitValueDesc(raw) : null;

                  if (split) {
                    return (
                      <td key={k} className={styles.tdValueDesc}>
                        <span className={styles.valueBadge}>{split.value}</span>
                        <span className={styles.valueDesc}>{split.desc}</span>
                      </td>
                    );
                  }

                  // In annotated tables, style the key column as a dim mono identifier.
                  if (hasAnnotated && ki === 0) {
                    return (
                      <td key={k} className={styles.tdParamKey}>
                        {raw}
                      </td>
                    );
                  }

                  return <td key={k}>{raw}</td>;
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
});

// ── Main component ───────────────────────────────────────────────────────────

const ProcessorDashboard = React.memo(function ProcessorDashboard() {
  const session = useSession();
  const processors = useProcessors();
  const activeProcessorIds = useActiveProcessorIds();
  const { results: lastResults, runCount } = usePipelineResults();
  const { jumpToLine } = useViewerActions();
  const pipeline = usePipeline();
  const { fetchCharts } = useChartData();

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [vars, setVars] = useState<Record<string, unknown> | null>(null);
  const [piiMappings, setPiiMappings] = useState<Record<string, string>>({});
  const [showMatches, setShowMatches] = useState(false);
  const [matchedLines, setMatchedLines] = useState<MatchedLine[]>([]);
  const [matchesLoading, setMatchesLoading] = useState(false);
  const [matchSearch, setMatchSearch] = useState('');

  // State tracker detail
  const [trackerTransitions, setTrackerTransitions] = useState<StateTransition[]>([]);
  const [trackerSnapshot, setTrackerSnapshot] = useState<StateSnapshot | null>(null);
  // Correlator detail
  const [correlatorResult, setCorrelatorResult] = useState<CorrelatorResult | null>(null);

  const sessionId = session?.sessionId ?? null;

  const activeProcessors = useMemo(
    () =>
      activeProcessorIds
        .map((id) => processors.find((p) => p.id === id))
        .filter(Boolean) as NonNullable<(typeof processors)[0]>[],
    [activeProcessorIds, processors],
  );

  const selected = selectedId ?? activeProcessors[0]?.id ?? null;
  const selectedProc = activeProcessors.find((p) => p.id === selected);

  const getSummary = (id: string) =>
    (lastResults as PipelineRunSummary[]).find((r) => r.processorId === id);

  // Fetch vars
  useEffect(() => {
    if (!selected || !sessionId || runCount === 0) {
      setVars(null);
      return;
    }
    pipeline
      .getVars(sessionId, selected)
      .then(setVars)
      .catch(() => setVars(null));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected, sessionId, runCount]);

  // Fetch charts
  useEffect(() => {
    if (selected && sessionId && runCount > 0) {
      fetchCharts(sessionId, selected);
    }
  }, [selected, sessionId, runCount, fetchCharts]);

  // PII mappings
  useEffect(() => {
    if (selected === '__pii_anonymizer' && sessionId && runCount > 0) {
      getPiiMappings(sessionId)
        .then(setPiiMappings)
        .catch(() => setPiiMappings({}));
    }
  }, [selected, sessionId, runCount]);

  // Fetch state tracker transitions + final snapshot
  useEffect(() => {
    if (!selected || !sessionId || runCount === 0 || selectedProc?.processorType !== 'state_tracker') {
      setTrackerTransitions([]);
      setTrackerSnapshot(null);
      return;
    }
    let cancelled = false;
    Promise.all([
      getStateTransitions(sessionId, selected),
      getStateAtLine(sessionId, selected, Number.MAX_SAFE_INTEGER),
    ]).then(([transitions, snapshot]) => {
      if (cancelled) return;
      setTrackerTransitions(transitions);
      setTrackerSnapshot(snapshot);
    }).catch(() => {
      if (cancelled) return;
      setTrackerTransitions([]);
      setTrackerSnapshot(null);
    });
    return () => { cancelled = true; };
  }, [selected, sessionId, runCount, selectedProc?.processorType]);

  // Fetch correlator events
  useEffect(() => {
    if (!selected || !sessionId || runCount === 0 || selectedProc?.processorType !== 'correlator') {
      setCorrelatorResult(null);
      return;
    }
    let cancelled = false;
    getCorrelatorEvents(sessionId, selected)
      .then((result) => { if (!cancelled) setCorrelatorResult(result); })
      .catch(() => { if (!cancelled) setCorrelatorResult(null); });
    return () => { cancelled = true; };
  }, [selected, sessionId, runCount, selectedProc?.processorType]);

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

  useEffect(() => {
    if (showMatches && runCount > 0) fetchMatches();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runCount]);

  if (activeProcessors.length === 0) {
    return (
      <div className={styles.empty}>
        <span>No active processors.</span>
        <span className={styles.emptySub}>
          Add processors to the pipeline chain and run it.
        </span>
      </div>
    );
  }

  const varGroups = vars ? groupVars(vars) : null;
  const summary = selected ? getSummary(selected) : null;

  const displayMeta: VarMeta[] = (selectedProc?.varsMeta ?? []).filter(
    (m) => m.display,
  );
  const hasVarMeta = displayMeta.length > 0;

  const metaScalars =
    hasVarMeta && vars
      ? displayMeta.filter((m) => isNumeric(vars[m.name]))
      : [];
  const metaNonScalars =
    hasVarMeta && vars
      ? displayMeta.filter((m) => !isNumeric(vars[m.name]))
      : [];

  const filteredLines = matchSearch.trim()
    ? matchedLines.filter((l) =>
        l.raw.toLowerCase().includes(matchSearch.toLowerCase()),
      )
    : matchedLines;

  const totalMatches = (lastResults as PipelineRunSummary[]).reduce(
    (n, r) => n + r.matchedLines,
    0,
  );

  return (
    <div className={styles.layout}>
      {/* Left: processor list */}
      <div className={styles.procList}>
        <div className={styles.procListHeader}>
          {runCount > 0
            ? `${activeProcessors.length} processor${activeProcessors.length !== 1 ? 's' : ''} . ${totalMatches.toLocaleString()} matches`
            : `${activeProcessors.length} processor${activeProcessors.length !== 1 ? 's' : ''}`}
        </div>
        {activeProcessors.map((p) => {
          const s = getSummary(p.id);
          const isSelected = p.id === selected;
          return (
            <button
              key={p.id}
              className={`${styles.procCard}${isSelected ? ` ${styles.procCardActive}` : ''}`}
              onClick={() => {
                setSelectedId(p.id);
                setShowMatches(false);
              }}
            >
              <div className={styles.procCardName}>{p.name}</div>
              {s ? (
                <div className={styles.procCardStats}>
                  <span>{s.matchedLines.toLocaleString()} matches</span>
                  {s.emissionCount > 0 && (
                    <span className={styles.procCardEmissions}>
                      . {s.emissionCount.toLocaleString()} events
                    </span>
                  )}
                </div>
              ) : (
                <div className={`${styles.procCardStats} ${styles.procCardStatsDim}`}>
                  not run
                </div>
              )}
            </button>
          );
        })}
      </div>

      {/* Right: detail panel */}
      {selected && (
        <div className={styles.detail}>
          <div className={styles.detailHeader}>
            <div className={styles.detailTitle}>
              {selectedProc?.name}
              {selectedProc && (
                <span className={styles.detailTypeBadge}>
                  {selectedProc.processorType.replace('_', ' ')}
                </span>
              )}
            </div>
            {summary && runCount > 0 && (
              <div className={styles.detailMeta}>
                <span className={styles.metaChip}>
                  {summary.matchedLines.toLocaleString()}{' '}
                  {selectedProc?.processorType === 'state_tracker' ? 'transitions'
                    : selectedProc?.processorType === 'correlator' ? 'events'
                    : 'matched'}
                </span>
                {summary.emissionCount > 0 && (
                  <span className={`${styles.metaChip} ${styles.metaChipEmit}`}>
                    {summary.emissionCount.toLocaleString()} events
                  </span>
                )}
              </div>
            )}
            {summary && runCount > 0 && (summary.scriptErrors ?? 0) > 0 && (
              <div className={styles.scriptErrorBanner} title={summary.firstScriptError}>
                <span className={styles.scriptErrorIcon}>!</span>
                <span>
                  {summary.scriptErrors} script error{summary.scriptErrors !== 1 ? 's' : ''}
                  {summary.firstScriptError && (
                    <span className={styles.scriptErrorMsg}> — {summary.firstScriptError}</span>
                  )}
                </span>
              </div>
            )}
            {selectedProc?.description && (
              <p className={styles.detailDesc}>{selectedProc.description}</p>
            )}
          </div>

          {runCount === 0 ? (
            <div className={styles.hint}>Run the pipeline to see results.</div>
          ) : (
            <div className={styles.detailBody}>
              {/* Metadata-driven var rendering */}
              {hasVarMeta && vars && metaScalars.length > 0 && (
                <div className={styles.statGrid}>
                  {metaScalars.map((m) => (
                    <StatCard
                      key={m.name}
                      label={m.label}
                      value={vars[m.name] as number}
                    />
                  ))}
                </div>
              )}

              {hasVarMeta &&
                vars &&
                metaNonScalars.map((m) => {
                  const value = vars[m.name];
                  if (typeof value === 'string') {
                    return (
                      <div key={m.name} className={styles.section}>
                        <div className={styles.stringList}>
                          <div className={styles.stringRow}>
                            <span className={styles.stringKey}>{m.label}</span>
                            <span className={styles.stringVal}>
                              {value || '---'}
                            </span>
                          </div>
                        </div>
                      </div>
                    );
                  }
                  if (
                    m.displayAs === 'table' &&
                    typeof value === 'object' &&
                    value !== null &&
                    !Array.isArray(value)
                  ) {
                    const colKey = m.columns[0] ?? 'key';
                    const colVal = m.columns[1] ?? 'value';
                    let rows: Record<string, unknown>[];
                    if (isRankedObject(value)) {
                      // Numeric values — sort descending by count
                      rows = Object.entries(value as Record<string, number>)
                        .sort((a, b) => b[1] - a[1])
                        .map(([k, v]) => ({ [colKey]: k, [colVal]: v }));
                    } else {
                      // String (or mixed) values — preserve insertion order
                      rows = Object.entries(value as Record<string, unknown>)
                        .map(([k, v]) => ({ [colKey]: k, [colVal]: String(v) }));
                    }
                    return (
                      <DataTable
                        key={m.name}
                        name={m.name}
                        label={m.label}
                        value={rows}
                      />
                    );
                  }
                  if (
                    Array.isArray(value) &&
                    value.length > 0 &&
                    typeof value[0] === 'object'
                  ) {
                    return (
                      <DataTable
                        key={m.name}
                        name={m.name}
                        label={m.label}
                        value={value as Record<string, unknown>[]}
                      />
                    );
                  }
                  if (isRankedObject(value)) {
                    return (
                      <RankedList
                        key={m.name}
                        name={m.name}
                        label={m.label}
                        value={value as Record<string, number>}
                      />
                    );
                  }
                  return null;
                })}

              {/* Fallback: type-inferred rendering */}
              {!hasVarMeta && varGroups && varGroups.scalars.length > 0 && (
                <div className={styles.statGrid}>
                  {varGroups.scalars.map(({ name, value }) => (
                    <StatCard key={name} label={name} value={value} />
                  ))}
                </div>
              )}

              {!hasVarMeta && varGroups && varGroups.strings.length > 0 && (
                <div className={styles.section}>
                  <div className={styles.sectionLabel}>Values</div>
                  <div className={styles.stringList}>
                    {varGroups.strings.map(({ name, value }) => (
                      <div key={name} className={styles.stringRow}>
                        <span className={styles.stringKey}>
                          {snakeToTitle(name)}
                        </span>
                        <span className={styles.stringVal}>
                          {value || '---'}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {!hasVarMeta &&
                varGroups &&
                varGroups.ranked.map(({ name, value }) => (
                  <RankedList key={name} name={name} value={value} />
                ))}

              {!hasVarMeta &&
                varGroups &&
                varGroups.tables.map(({ name, value }) => (
                  <DataTable key={name} name={name} value={value} />
                ))}

              {/* State tracker detail */}
              {selectedProc?.processorType === 'state_tracker' && trackerSnapshot && (
                <div className={styles.section}>
                  <div className={styles.sectionLabel}>Final State</div>
                  <div className={styles.stringList}>
                    {Object.entries(trackerSnapshot.fields)
                      .sort(([a], [b]) => a.localeCompare(b))
                      .map(([key, val]) => {
                        const initialized = trackerSnapshot.initializedFields.includes(key);
                        return (
                          <div key={key} className={styles.stringRow} style={initialized ? undefined : { opacity: 0.4 }}>
                            <span className={styles.stringKey}>{key}</span>
                            <span className={initialized ? styles.stringVal : styles.stringKey}>
                              {initialized ? String(val ?? '') : '--'}
                            </span>
                          </div>
                        );
                      })}
                  </div>
                </div>
              )}

              {selectedProc?.processorType === 'state_tracker' && trackerTransitions.length > 0 && (
                <div className={styles.section}>
                  <div className={styles.sectionLabel}>
                    Transitions ({trackerTransitions.length})
                  </div>
                  <div className={styles.tableWrap}>
                    <table className={styles.dataTable}>
                      <thead>
                        <tr>
                          <th>Line</th>
                          <th>Transition</th>
                          <th>Changes</th>
                        </tr>
                      </thead>
                      <tbody>
                        {trackerTransitions.slice(0, 100).map((t, i) => (
                          <tr
                            key={i}
                            style={{ cursor: 'pointer' }}
                            onClick={() => jumpToLine(t.lineNum)}
                            title={`Jump to line ${t.lineNum + 1}`}
                          >
                            <td style={{ fontFamily: 'var(--font-mono)', fontSize: 10 }}>
                              {(t.lineNum + 1).toLocaleString()}
                            </td>
                            <td>{t.transitionName}</td>
                            <td style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--text-dimmed)' }}>
                              {Object.entries(t.changes).map(([k, c]) =>
                                `${k}: ${String(c.to)}`
                              ).join(', ')}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                    {trackerTransitions.length > 100 && (
                      <div className={styles.hint}>
                        Showing first 100 of {trackerTransitions.length} transitions
                      </div>
                    )}
                  </div>
                </div>
              )}

              {/* Correlator detail */}
              {selectedProc?.processorType === 'correlator' && correlatorResult && (
                <>
                  {correlatorResult.guidance && (
                    <div className={styles.section}>
                      <p className={styles.detailDesc}>{correlatorResult.guidance}</p>
                    </div>
                  )}
                  {correlatorResult.events.length > 0 ? (
                    <div className={styles.section}>
                      <div className={styles.sectionLabel}>
                        Correlation Events ({correlatorResult.events.length})
                      </div>
                      <div className={styles.tableWrap}>
                        <table className={styles.dataTable}>
                          <thead>
                            <tr>
                              <th>Line</th>
                              <th>Message</th>
                            </tr>
                          </thead>
                          <tbody>
                            {correlatorResult.events.slice(0, 100).map((ev, i) => (
                              <tr
                                key={i}
                                style={{ cursor: 'pointer' }}
                                onClick={() => jumpToLine(ev.triggerLineNum)}
                                title={`Jump to line ${ev.triggerLineNum + 1}`}
                              >
                                <td style={{ fontFamily: 'var(--font-mono)', fontSize: 10 }}>
                                  {(ev.triggerLineNum + 1).toLocaleString()}
                                </td>
                                <td>{ev.message}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                        {correlatorResult.events.length > 100 && (
                          <div className={styles.hint}>
                            Showing first 100 of {correlatorResult.events.length} events
                          </div>
                        )}
                      </div>
                    </div>
                  ) : (
                    <div className={styles.hint}>No correlation events detected.</div>
                  )}
                </>
              )}

              {/* PII token mapping */}
              {selected === '__pii_anonymizer' && (
                <div className={styles.section}>
                  <div className={styles.sectionLabel}>Token Mapping</div>
                  {Object.keys(piiMappings).length === 0 ? (
                    <div className={styles.hint}>No token mappings yet.</div>
                  ) : (
                    <div className={styles.tableWrap}>
                      <table className={styles.dataTable}>
                        <thead>
                          <tr>
                            <th>Token</th>
                            <th>Original</th>
                          </tr>
                        </thead>
                        <tbody>
                          {Object.entries(piiMappings).map(([token, original]) => (
                            <tr key={token}>
                              <td>
                                <code>{token}</code>
                              </td>
                              <td>{original}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>
              )}

              {/* Matches section */}
              <div className={styles.section}>
                <button
                  className={styles.matchesToggle}
                  onClick={handleToggleMatches}
                >
                  <span className={styles.matchesArrow}>
                    {showMatches ? '>' : '>'}
                  </span>
                  <span className={styles.sectionLabel}>
                    Matched Lines
                    {summary && (
                      <span className={styles.metaChip} style={{ marginLeft: 8 }}>
                        {summary.matchedLines.toLocaleString()}
                      </span>
                    )}
                  </span>
                </button>

                {showMatches && (
                  <div className={styles.matchesBody}>
                    {matchedLines.length > 0 && (
                      <div className={styles.matchesSearchRow}>
                        <input
                          className={styles.matchesSearch}
                          type="text"
                          placeholder="Filter..."
                          value={matchSearch}
                          onChange={(e) => setMatchSearch(e.target.value)}
                          spellCheck={false}
                        />
                        {matchSearch.trim() && (
                          <span className={styles.matchesCount}>
                            {filteredLines.length} / {matchedLines.length}
                          </span>
                        )}
                      </div>
                    )}
                    {matchesLoading && (
                      <div className={styles.hint}>Loading...</div>
                    )}
                    {!matchesLoading &&
                      filteredLines.map((line) => (
                        <div
                          key={line.lineNum}
                          className={styles.matchRow}
                          onClick={() => jumpToLine(line.lineNum)}
                          title={`Jump to line ${line.lineNum}`}
                        >
                          <span className={styles.matchNum}>
                            {line.lineNum + 1}
                          </span>
                          <span className={styles.matchRaw}>{line.raw}</span>
                        </div>
                      ))}
                    {!matchesLoading && matchedLines.length === 0 && (
                      <div className={styles.hint}>No matched lines.</div>
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
});

export default ProcessorDashboard;
