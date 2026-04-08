import React from 'react';
import type { PipelineRunSummary, ProcessorSummary, VarMeta } from '../../bridge/types';
import { isNumeric, isRankedObject, groupVars } from './utils';
import { StatCard, RankedList, DataTable } from './SubComponents';
import type { UseProcessorDetailResult } from './useProcessorDetail';
import styles from './ProcessorDashboard.module.css';

interface ProcessorDetailViewProps {
  detail: UseProcessorDetailResult;
  selectedProc: ProcessorSummary | null;
  summary: PipelineRunSummary | undefined;
  runCount: number;
  jumpToLine: (line: number) => void;
  selectedId: string | null;
}

export const ProcessorDetailView = React.memo(function ProcessorDetailView({
  detail,
  selectedProc,
  summary,
  runCount,
  jumpToLine,
  selectedId,
}: ProcessorDetailViewProps) {
  const {
    vars,
    piiMappings,
    trackerTransitions,
    trackerSnapshot,
    correlatorResult,
    matchedLines,
    matchesLoading,
    showMatches,
    matchSearch,
    handleToggleMatches,
    setMatchSearch,
  } = detail;

  const varGroups = vars ? groupVars(vars) : null;

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

  return (
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
                      {name.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())}
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
                        className={styles.clickableRow}
                        onClick={() => jumpToLine(t.lineNum)}
                        title={`Jump to line ${t.lineNum + 1}`}
                      >
                        <td className={styles.tdMono}>
                          {(t.lineNum + 1).toLocaleString()}
                        </td>
                        <td>{t.transitionName}</td>
                        <td className={styles.tdMonoDim}>
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
                            className={styles.clickableRow}
                            onClick={() => jumpToLine(ev.triggerLineNum)}
                            title={`Jump to line ${ev.triggerLineNum + 1}`}
                          >
                            <td className={styles.tdMono}>
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
          {selectedId === '__pii_anonymizer' && (
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
                  <span className={`${styles.metaChip} ${styles.metaChipOffset}`}>
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
  );
});
