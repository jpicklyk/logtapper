import React, { useState, useCallback } from 'react';
import type { Source } from '../../bridge/types';
import css from './MarketplacePanel.module.css';

interface Props {
  sources: Source[];
  addSource: (source: Source) => Promise<void>;
  removeSource: (name: string) => Promise<void>;
}

export const SourcesTab = React.memo(function SourcesTab({
  sources,
  addSource,
  removeSource,
}: Props) {
  const [showForm, setShowForm] = useState(false);
  const [formName, setFormName] = useState('');
  const [formType, setFormType] = useState<'github' | 'local'>('github');
  const [formRepo, setFormRepo] = useState('');
  const [formPath, setFormPath] = useState('');
  const [formError, setFormError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);

  const handleAdd = useCallback(async () => {
    if (!formName.trim()) {
      setFormError('Name is required');
      return;
    }
    setFormError(null);
    setAdding(true);
    try {
      const source: Source = {
        name: formName.trim(),
        type: formType,
        repo: formType === 'github' ? formRepo.trim() : undefined,
        path: formType === 'local' ? formPath.trim() : undefined,
        enabled: true,
        autoUpdate: false,
      };
      await addSource(source);
      setFormName('');
      setFormRepo('');
      setFormPath('');
      setShowForm(false);
    } catch (e) {
      setFormError(String(e));
    } finally {
      setAdding(false);
    }
  }, [formName, formType, formRepo, formPath, addSource]);

  const [removing, setRemoving] = useState<string | null>(null);

  const handleRemove = useCallback(
    async (name: string) => {
      setRemoving(name);
      try {
        await removeSource(name);
      } finally {
        setRemoving(null);
      }
    },
    [removeSource],
  );

  return (
    <div className={css.sourcesTab}>
      <div className={css.scroll}>
        {sources.length === 0 && (
          <div className={css.empty}>No sources configured.</div>
        )}
        {sources.map((s) => (
          <div key={s.name} className={css.sourceRow}>
            <div className={css.sourceIcon}>
              {s.type === 'github' ? (
                <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
                  <path
                    d="M8 0.5C3.58 0.5 0 4.08 0 8.5c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0016 8.5c0-4.42-3.58-8-8-8z"
                    fill="currentColor"
                  />
                </svg>
              ) : (
                <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
                  <path
                    d="M1 3.5A1.5 1.5 0 012.5 2h3.879a1.5 1.5 0 011.06.44l.561.56H13.5A1.5 1.5 0 0115 4.5v8a1.5 1.5 0 01-1.5 1.5h-11A1.5 1.5 0 011 12.5v-9z"
                    stroke="currentColor"
                    strokeWidth="1.3"
                  />
                </svg>
              )}
            </div>
            <div className={css.sourceInfo}>
              <span className={css.sourceName}>{s.name}</span>
              <span className={css.sourcePath}>
                {s.type === 'github' ? s.repo : s.path}
              </span>
              {s.lastChecked && (
                <span className={css.sourceChecked}>
                  Last checked: {new Date(Number(s.lastChecked.replace('Z', '')) * 1000).toLocaleString()}
                </span>
              )}
            </div>
            <div className={css.sourceActions}>
              <span className={`${css.sourceStatus}${s.enabled ? ` ${css.sourceEnabled}` : ''}`}>
                {s.enabled ? 'Enabled' : 'Disabled'}
              </span>
              {s.name !== 'official' && (
                <button
                  className={css.removeBtn}
                  onClick={() => handleRemove(s.name)}
                  disabled={removing === s.name}
                  title="Remove source"
                >
                  {removing === s.name ? <span className={css.spinner} /> : '\u00D7'}
                </button>
              )}
            </div>
          </div>
        ))}
      </div>

      <div className={css.addSection}>
        {showForm ? (
          <div className={css.addForm}>
            <div className={css.formRow}>
              <input
                className={css.formInput}
                placeholder="Source name"
                value={formName}
                onChange={(e) => setFormName(e.target.value)}
              />
              <select
                className={css.sourceSelect}
                value={formType}
                onChange={(e) => setFormType(e.target.value as 'github' | 'local')}
              >
                <option value="github">GitHub</option>
                <option value="local">Local</option>
              </select>
            </div>
            {formType === 'github' ? (
              <input
                className={css.formInput}
                placeholder="owner/repo (e.g. myorg/processors)"
                value={formRepo}
                onChange={(e) => setFormRepo(e.target.value)}
              />
            ) : (
              <input
                className={css.formInput}
                placeholder="Local path"
                value={formPath}
                onChange={(e) => setFormPath(e.target.value)}
              />
            )}
            {formError && <div className={css.errorBar}>{formError}</div>}
            <div className={css.formActions}>
              <button className={css.actionBtn} onClick={handleAdd} disabled={adding}>
                {adding ? <><span className={css.spinner} /> Adding...</> : 'Add Source'}
              </button>
              <button
                className={css.actionBtnSecondary}
                onClick={() => { setShowForm(false); setFormError(null); }}
              >
                Cancel
              </button>
            </div>
          </div>
        ) : (
          <button className={css.addSourceBtn} onClick={() => setShowForm(true)}>
            + Add Source
          </button>
        )}
      </div>
    </div>
  );
});
