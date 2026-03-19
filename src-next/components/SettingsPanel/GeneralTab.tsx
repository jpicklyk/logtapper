import { memo, useCallback, useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import type { AppSettings, UseSettingsResult, BookmarkCategoryDef } from '../../hooks';
import { SETTING_DEFAULTS, DEFAULT_BOOKMARK_CATEGORIES } from '../../hooks';
import css from './SettingsPanel.module.css';

function formatNumber(n: number): string {
  return n.toLocaleString();
}

function estimateCacheMB(lines: number): string {
  const bytes = lines * 500;
  if (bytes >= 1_000_000_000) return `~${(bytes / 1_000_000_000).toFixed(1)} GB`;
  return `~${(bytes / 1_000_000).toFixed(0)} MB`;
}

interface GeneralTabProps {
  settings: AppSettings;
  onUpdate: UseSettingsResult['updateSetting'];
}

export const GeneralTab = memo(function GeneralTab({ settings, onUpdate }: GeneralTabProps) {
  const handleNumberInput = useCallback(
    (key: keyof AppSettings, raw: string, fallback: number) => {
      const parsed = parseInt(raw.replace(/,/g, ''), 10);
      onUpdate(key, isNaN(parsed) || parsed < 1 ? fallback : parsed);
    },
    [onUpdate],
  );

  return (
    <>
      <div className={css.section}>
        <div className={css.sectionTitle}>Viewer</div>
        <div className={css.row}>
          <div className={css.label}>
            <span className={css.labelText}>Line cache</span>
            <span className={css.labelHint}>
              Total lines cached in the viewer for both file and streaming modes.
              Default: {formatNumber(SETTING_DEFAULTS.fileCacheBudget)}.
            </span>
          </div>
          <div className={css.control}>
            <input
              type="number"
              className={css.input}
              value={settings.fileCacheBudget}
              min={10_000}
              max={1_000_000}
              step={10_000}
              onChange={(e) =>
                handleNumberInput(
                  'fileCacheBudget',
                  e.target.value,
                  SETTING_DEFAULTS.fileCacheBudget,
                )
              }
            />
            <span className={css.unit}>
              lines ({estimateCacheMB(settings.fileCacheBudget)})
            </span>
          </div>
        </div>
      </div>

      <div className={css.section}>
        <div className={css.sectionTitle}>ADB Streaming</div>
        <div className={css.row}>
          <div className={css.label}>
            <span className={css.labelText}>Backend log buffer</span>
            <span className={css.labelHint}>
              Max raw log lines stored in the backend. Evicted lines are spilled to disk.
              Default: {formatNumber(SETTING_DEFAULTS.streamBackendLineMax)}.
            </span>
          </div>
          <div className={css.control}>
            <input
              type="number"
              className={css.input}
              value={settings.streamBackendLineMax}
              min={10_000}
              max={5_000_000}
              step={50_000}
              onChange={(e) =>
                handleNumberInput(
                  'streamBackendLineMax',
                  e.target.value,
                  SETTING_DEFAULTS.streamBackendLineMax,
                )
              }
            />
            <span className={css.unit}>lines</span>
          </div>
        </div>
        <div className={css.row}>
          <div className={css.label}>
            <span className={css.labelText}>Auto-reconnect on disconnect</span>
            <span className={css.labelHint}>
              Automatically restart the stream after an unexpected EOF (e.g. screen unlock
              USB reset). Stops retrying after 5 consecutive quick failures.
            </span>
          </div>
          <div className={css.control}>
            <input
              type="checkbox"
              checked={settings.autoReconnectStream}
              onChange={(e) => onUpdate('autoReconnectStream', e.target.checked)}
            />
          </div>
        </div>
      </div>

      <div className={css.section}>
        <div className={css.sectionTitle}>Bookmark Categories</div>
        <div className={css.row} style={{ flexDirection: 'column', gap: 6 }}>
          <span className={css.labelHint}>
            Categories used to classify bookmarks. Each has a display label and color.
          </span>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4, width: '100%' }}>
            {settings.bookmarkCategories.map((cat, i) => (
              <CategoryRow
                key={cat.id}
                cat={cat}
                onUpdate={(updated) => {
                  const next = [...settings.bookmarkCategories];
                  next[i] = updated;
                  onUpdate('bookmarkCategories', next);
                }}
                onDelete={() => {
                  const next = settings.bookmarkCategories.filter((_, j) => j !== i);
                  onUpdate('bookmarkCategories', next);
                }}
                canDelete={settings.bookmarkCategories.length > 1}
              />
            ))}
          </div>
          <div style={{ display: 'flex', gap: 6, marginTop: 4 }}>
            <AddCategoryButton
              onAdd={(cat) => {
                onUpdate('bookmarkCategories', [...settings.bookmarkCategories, cat]);
              }}
              existingIds={settings.bookmarkCategories.map((c) => c.id)}
            />
            <button
              className={css.linkBtn}
              type="button"
              onClick={() => onUpdate('bookmarkCategories', DEFAULT_BOOKMARK_CATEGORIES)}
            >
              Reset to defaults
            </button>
          </div>
        </div>
      </div>
    </>
  );
});

// ── Category settings helpers ─────────────────────────────────────────────

function CategoryRow({ cat, onUpdate, onDelete, canDelete }: {
  cat: BookmarkCategoryDef;
  onUpdate: (cat: BookmarkCategoryDef) => void;
  onDelete: () => void;
  canDelete: boolean;
}) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
      <input
        type="color"
        value={cat.color}
        onChange={(e) => onUpdate({ ...cat, color: e.target.value })}
        title="Category color"
        style={{ width: 24, height: 24, border: 'none', padding: 0, cursor: 'pointer', background: 'transparent' }}
      />
      <input
        type="text"
        className={css.input}
        value={cat.label}
        onChange={(e) => onUpdate({ ...cat, label: e.target.value })}
        style={{ flex: 1, minWidth: 0 }}
        placeholder="Label"
      />
      <span style={{ fontSize: 10, color: 'var(--text-dimmed)', fontFamily: 'var(--font-mono)', minWidth: 60 }}>
        {cat.id}
      </span>
      {canDelete && (
        <button
          type="button"
          onClick={onDelete}
          title="Remove category"
          style={{ background: 'none', border: 'none', color: 'var(--text-dimmed)', cursor: 'pointer', padding: 2 }}
        >
          <Trash2 size={12} />
        </button>
      )}
    </div>
  );
}

function AddCategoryButton({ onAdd, existingIds }: {
  onAdd: (cat: BookmarkCategoryDef) => void;
  existingIds: string[];
}) {
  const [adding, setAdding] = useState(false);
  const [newId, setNewId] = useState('');
  const [newLabel, setNewLabel] = useState('');

  const handleSubmit = useCallback(() => {
    const id = newId.trim().toLowerCase().replace(/\s+/g, '-');
    if (!id || existingIds.includes(id)) return;
    onAdd({ id, label: newLabel.trim() || id, color: '#8b949e' });
    setNewId('');
    setNewLabel('');
    setAdding(false);
  }, [newId, newLabel, existingIds, onAdd]);

  if (!adding) {
    return (
      <button
        className={css.linkBtn}
        type="button"
        onClick={() => setAdding(true)}
      >
        <Plus size={12} /> Add category
      </button>
    );
  }

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
      <input
        type="text"
        className={css.input}
        value={newId}
        onChange={(e) => setNewId(e.target.value)}
        placeholder="id (e.g. network)"
        style={{ width: 100 }}
        autoFocus
        onKeyDown={(e) => { if (e.key === 'Enter') handleSubmit(); if (e.key === 'Escape') setAdding(false); }}
      />
      <input
        type="text"
        className={css.input}
        value={newLabel}
        onChange={(e) => setNewLabel(e.target.value)}
        placeholder="Label (e.g. Network)"
        style={{ width: 120 }}
        onKeyDown={(e) => { if (e.key === 'Enter') handleSubmit(); if (e.key === 'Escape') setAdding(false); }}
      />
      <button className={css.linkBtn} type="button" onClick={handleSubmit}>Add</button>
      <button className={css.linkBtn} type="button" onClick={() => setAdding(false)}>Cancel</button>
    </div>
  );
}
