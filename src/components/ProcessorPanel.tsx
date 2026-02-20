import { useEffect, useRef, useState } from 'react';
import type { PipelineState } from '../hooks/usePipeline';

interface Props {
  pipeline: PipelineState;
  sessionId: string | null;
  isStreaming: boolean;
}

// Type → [label, CSS class, accent color for left border]
const PROC_TYPE_META: Record<string, [string, string, string]> = {
  transformer:  ['Transformer',  'proc-type-transformer', '#2dd4bf'],
  reporter:     ['Reporter',     'proc-type-reporter',    '#58a6ff'],
  state_tracker:['StateTracker', 'proc-type-tracker',     '#60a5fa'],
  correlator:   ['Correlator',   'proc-type-correlator',  '#c084fc'],
  annotator:    ['Annotator',    'proc-type-annotator',   '#fb923c'],
};

function TypeBadge({ type }: { type: string }) {
  const meta = PROC_TYPE_META[type];
  if (!meta) return null;
  return <span className={`proc-type-badge ${meta[1]}`}>{meta[0]}</span>;
}

export default function ProcessorPanel({ pipeline, sessionId, isStreaming }: Props) {
  const [yamlInput, setYamlInput] = useState('');
  const [showImport, setShowImport] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    pipeline.loadProcessors();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function handleImport() {
    setImportError(null);
    try {
      await pipeline.installFromYaml(yamlInput);
      setYamlInput('');
      setShowImport(false);
    } catch (e) {
      setImportError(String(e));
    }
  }

  async function handleFileUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    const text = await file.text();
    setYamlInput(text);
    setShowImport(true);
    e.target.value = '';
  }

  async function handleRun() {
    if (!sessionId) return;
    await pipeline.run(sessionId);
  }

  const hasActive = pipeline.activeProcessorIds.size > 0;
  const canRun = hasActive && !!sessionId && !pipeline.running;

  return (
    <div className="processor-panel">

      {/* ── Header ── */}
      <div className="proc-panel-header">
        <div className="proc-panel-title-group">
          <span className="proc-panel-title">Processors</span>
          {pipeline.processors.length > 0 && (
            <span className="proc-panel-count">{pipeline.processors.length}</span>
          )}
        </div>
        <div className="proc-panel-actions">
          <button
            className="proc-action-btn"
            title="Upload processor YAML"
            onClick={() => fileInputRef.current?.click()}
          >
            <svg width="13" height="13" viewBox="0 0 14 14" fill="none">
              <path d="M7 1v8M3.5 4.5L7 1l3.5 3.5M2 11h10" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
          </button>
          <button
            className={`proc-action-btn${showImport ? ' proc-action-btn--active' : ''}`}
            title="Paste processor YAML"
            onClick={() => setShowImport((v) => !v)}
          >
            <svg width="13" height="13" viewBox="0 0 14 14" fill="none">
              <path d="M7 2v10M2 7h10" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
            </svg>
          </button>
        </div>
      </div>

      <input
        ref={fileInputRef}
        type="file"
        accept=".yaml,.yml"
        style={{ display: 'none' }}
        onChange={handleFileUpload}
      />

      {/* ── YAML Import ── */}
      {showImport && (
        <div className="proc-import">
          <div className="proc-import-label">Paste YAML</div>
          <textarea
            className="proc-yaml-input"
            placeholder="type: reporter&#10;id: my_processor&#10;name: My Processor&#10;…"
            value={yamlInput}
            onChange={(e) => setYamlInput(e.target.value)}
            rows={7}
            spellCheck={false}
            autoFocus
          />
          {importError && <div className="proc-import-error">{importError}</div>}
          <div className="proc-import-btns">
            <button
              className="btn-primary"
              onClick={handleImport}
              disabled={!yamlInput.trim()}
            >
              Install
            </button>
            <button
              className="btn-secondary"
              onClick={() => { setShowImport(false); setImportError(null); }}
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* ── Processor list ── */}
      <div className="proc-list">
        {pipeline.processors.length === 0 && (
          <div className="proc-empty">
            <svg width="28" height="28" viewBox="0 0 24 24" fill="none" className="proc-empty-icon">
              <rect x="3" y="3" width="18" height="18" rx="3" stroke="currentColor" strokeWidth="1.2"/>
              <path d="M9 12h6M12 9v6" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"/>
            </svg>
            <span>No processors installed</span>
            <span className="proc-empty-sub">Upload a YAML file to get started</span>
          </div>
        )}
        {pipeline.processors.map((p, idx) => {
          const active = pipeline.activeProcessorIds.has(p.id);
          const prog = pipeline.progress[p.id];
          const accentColor = PROC_TYPE_META[p.processorType]?.[2] ?? '#58a6ff';
          return (
            <div
              key={p.id}
              className={`proc-item${active ? ' proc-item-active' : ''}${p.builtin ? ' proc-item-builtin' : ''}`}
              style={{
                '--proc-accent': accentColor,
                '--proc-idx': idx,
              } as React.CSSProperties}
            >
              {/* Left accent bar */}
              <span className="proc-item-accent" />

              {/* Checkbox + name row */}
              <label className="proc-item-check">
                <input
                  type="checkbox"
                  checked={active}
                  onChange={() => pipeline.toggleProcessor(p.id)}
                />
                <span className="proc-item-name">{p.name}</span>
              </label>

              {/* Meta row: type badge + tags + version */}
              <div className="proc-item-meta">
                <TypeBadge type={p.processorType} />
                {p.tags.map((t) => (
                  <span key={t} className="proc-tag">{t}</span>
                ))}
                {!p.builtin && (
                  <span className="proc-item-version">v{p.version}</span>
                )}
                {p.builtin && (
                  <span className="proc-item-builtin-badge">built-in</span>
                )}
              </div>

              {/* Progress bar */}
              {prog && pipeline.running && (
                <div className="proc-progress">
                  <div
                    className="proc-progress-fill"
                    style={{ width: `${prog.percent.toFixed(0)}%` }}
                  />
                  <div className="proc-progress-shimmer" />
                </div>
              )}

              {/* Remove button */}
              {!p.builtin && (
                <button
                  className="proc-remove"
                  title="Uninstall processor"
                  onClick={() => pipeline.removeProcessor(p.id)}
                >
                  <svg width="9" height="9" viewBox="0 0 10 10" fill="none">
                    <path d="M1 1l8 8M9 1L1 9" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
                  </svg>
                </button>
              )}
            </div>
          );
        })}
      </div>

      {/* ── Run row ── */}
      <div className="proc-run-row">
        <button
          className={`proc-run-btn${canRun ? ' proc-run-btn--ready' : ''}${pipeline.running ? ' proc-run-btn--running' : ''}`}
          onClick={handleRun}
          disabled={!canRun}
          title={
            !sessionId ? 'Load a log file first' :
            !hasActive ? 'Check at least one processor to run' :
            isStreaming ? 'Process all currently captured lines' :
            'Run selected processors'
          }
        >
          {pipeline.running ? (
            <>
              <span className="proc-run-spinner" />
              Running…
            </>
          ) : (
            <>
              <svg width="11" height="11" viewBox="0 0 12 12" fill="none">
                <path d="M3 1.5l7 4.5-7 4.5V1.5z" fill="currentColor"/>
              </svg>
              {isStreaming ? 'Run on Buffer' : 'Run'}
            </>
          )}
        </button>
        {pipeline.running && (
          <button className="btn-secondary" onClick={pipeline.stop}>
            Stop
          </button>
        )}
        {!hasActive && !pipeline.running && pipeline.processors.length > 0 && (
          <span className="proc-hint">Select a processor</span>
        )}
      </div>

      {/* ── Error ── */}
      {pipeline.error && (
        <div className="proc-error">{pipeline.error}</div>
      )}

      {/* ── Results summary ── */}
      {pipeline.lastResults.length > 0 && !pipeline.running && (
        <div className="proc-results-summary">
          <div className="proc-results-label">Last Run</div>
          {pipeline.lastResults
            .filter((r) => r.matchedLines > 0 || r.emissionCount > 0)
            .map((r) => (
              <div key={r.processorId} className="proc-result-row">
                <span className="proc-result-id">{r.processorId}</span>
                <span className="proc-result-stat">
                  <span className="proc-result-num">{r.matchedLines.toLocaleString()}</span>
                  {' '}matched
                </span>
                {r.emissionCount > 0 && (
                  <span className="proc-result-stat">
                    <span className="proc-result-num">{r.emissionCount.toLocaleString()}</span>
                    {' '}emitted
                  </span>
                )}
              </div>
          ))}
        </div>
      )}
    </div>
  );
}
