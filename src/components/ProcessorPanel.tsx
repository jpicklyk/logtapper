import { useEffect, useRef, useState } from 'react';
import type { PipelineState } from '../hooks/usePipeline';
import { setStreamAnonymize } from '../bridge/commands';

interface Props {
  pipeline: PipelineState;
  sessionId: string | null;
  isStreaming: boolean;
}

export default function ProcessorPanel({ pipeline, sessionId, isStreaming }: Props) {
  const [yamlInput, setYamlInput] = useState('');
  const [showImport, setShowImport] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);
  const [anonymize, setAnonymize] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    pipeline.loadProcessors();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Sync anonymize toggle to the backend while a stream is active.
  // This enables/disables live PII anonymization of incoming stream lines.
  useEffect(() => {
    if (!isStreaming || !sessionId) return;
    setStreamAnonymize(sessionId, anonymize).catch(() => {});
  }, [isStreaming, sessionId, anonymize]);

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
    await pipeline.run(sessionId, anonymize);
  }

  const hasActive = pipeline.activeProcessorIds.size > 0;

  return (
    <div className="processor-panel">
      <div className="proc-panel-header">
        <span className="proc-panel-title">Processors</span>
        <div className="proc-panel-actions">
          <button
            className="btn-icon"
            title="Upload processor YAML"
            onClick={() => fileInputRef.current?.click()}
          >
            ↑
          </button>
          <button
            className="btn-icon"
            title="Paste processor YAML"
            onClick={() => setShowImport((v) => !v)}
          >
            +
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

      {showImport && (
        <div className="proc-import">
          <textarea
            className="proc-yaml-input"
            placeholder="Paste processor YAML here…"
            value={yamlInput}
            onChange={(e) => setYamlInput(e.target.value)}
            rows={8}
            spellCheck={false}
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

      <div className="proc-list">
        {pipeline.processors.length === 0 && (
          <div className="proc-empty">No processors installed. Upload a YAML file to get started.</div>
        )}
        {pipeline.processors.map((p) => {
          const active = pipeline.activeProcessorIds.has(p.id);
          const prog = pipeline.progress[p.id];
          return (
            <div key={p.id} className={`proc-item${active ? ' proc-item-active' : ''}${p.builtin ? ' proc-item-builtin' : ''}`}>
              <label className="proc-item-check">
                <input
                  type="checkbox"
                  checked={active}
                  onChange={() => pipeline.toggleProcessor(p.id)}
                />
                <span className="proc-item-name">{p.name}</span>
                {p.builtin && <span className="proc-item-builtin-badge">built-in</span>}
                {!p.builtin && <span className="proc-item-version">v{p.version}</span>}
              </label>
              {p.tags.length > 0 && (
                <div className="proc-tags">
                  {p.tags.map((t) => <span key={t} className="proc-tag">{t}</span>)}
                </div>
              )}
              {prog && pipeline.running && (
                <div className="proc-progress">
                  <div
                    className="proc-progress-fill"
                    style={{ width: `${prog.percent.toFixed(0)}%` }}
                  />
                </div>
              )}
              {!p.builtin && (
                <button
                  className="proc-remove"
                  title="Uninstall processor"
                  onClick={() => pipeline.removeProcessor(p.id)}
                >
                  ×
                </button>
              )}
            </div>
          );
        })}
      </div>

      <div className="proc-run-row">
        <label className="proc-anon-check">
          <input
            type="checkbox"
            checked={anonymize}
            onChange={(e) => setAnonymize(e.target.checked)}
          />
          Anonymize PII
        </label>
        <button
          className="btn-primary"
          onClick={handleRun}
          disabled={!hasActive || !sessionId || pipeline.running}
          title={
            !sessionId ? 'Load a log file first' :
            !hasActive ? 'Check at least one processor to run' :
            'Run selected processors'
          }
        >
          {pipeline.running ? 'Running…' : 'Run'}
        </button>
        {pipeline.running && (
          <button className="btn-secondary" onClick={pipeline.stop}>
            Stop
          </button>
        )}
      </div>

      {!hasActive && !pipeline.running && pipeline.processors.length > 0 && (
        <div className="proc-hint">Check one or more processors above, then click Run.</div>
      )}

      {pipeline.error && (
        <div className="proc-error">{pipeline.error}</div>
      )}

      {pipeline.lastResults.length > 0 && !pipeline.running && (
        <div className="proc-results-summary">
          {pipeline.lastResults.map((r) => (
            <div key={r.processorId} className="proc-result-row">
              <span className="proc-result-id">{r.processorId}</span>
              <span className="proc-result-stat">{r.matchedLines.toLocaleString()} matched</span>
              <span className="proc-result-stat">{r.emissionCount.toLocaleString()} emitted</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
