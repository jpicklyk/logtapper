import { memo, useCallback, useEffect, useState } from 'react';
import { ExternalLink, Moon, Monitor, Plus, Sun, Trash2 } from 'lucide-react';
import type { AppSettings, UseSettingsResult, BookmarkCategoryDef } from '../../hooks';
import { SETTING_DEFAULTS, DEFAULT_BOOKMARK_CATEGORIES } from '../../hooks';
import { useTheme } from '../../context';
import { SegmentedControl, Button, IconButton } from '../../ui';
import type { SegmentedOption } from '../../ui';
import type { ThemeMode } from '../../context';
import { getFileAssociationStatus, setFileAssociation, openDefaultAppsSettings, startMcpBridge, stopMcpBridge } from '../../bridge/commands';
import type { FileAssocEntry } from '../../bridge/types';
import { useMcpStatus } from '../../hooks';
import css from './SettingsPanel.module.css';

function formatNumber(n: number): string {
  return n.toLocaleString();
}

function estimateCacheMB(lines: number): string {
  const bytes = lines * 500;
  if (bytes >= 1_000_000_000) return `~${(bytes / 1_000_000_000).toFixed(1)} GB`;
  return `~${(bytes / 1_000_000).toFixed(0)} MB`;
}

const THEME_OPTIONS: SegmentedOption<ThemeMode>[] = [
  { value: 'dark',   icon: Moon,    tooltip: 'Dark'   },
  { value: 'light',  icon: Sun,     tooltip: 'Light'  },
  { value: 'system', icon: Monitor, tooltip: 'System' },
];

interface GeneralTabProps {
  settings: AppSettings;
  onUpdate: UseSettingsResult['updateSetting'];
}

export const GeneralTab = memo(function GeneralTab({ settings, onUpdate }: GeneralTabProps) {
  const { theme, setTheme } = useTheme();

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
        <div className={css.sectionTitle}>Appearance</div>
        <div className={css.row}>
          <div className={css.label}>
            <span className={css.labelText}>Theme</span>
            <span className={css.labelHint}>
              Choose between dark, light, or follow the system preference.
            </span>
          </div>
          <div className={css.control}>
            <SegmentedControl
              options={THEME_OPTIONS}
              value={theme}
              onChange={setTheme}
              size="md"
            />
          </div>
        </div>
      </div>

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

      <McpIntegrationSection settings={settings} onUpdate={onUpdate} />

      <FileAssociationsSection />

      <div className={css.section}>
        <div className={css.sectionTitle}>Bookmark Categories</div>
        <span className={css.labelHint}>
          Categories used to classify bookmarks. Click the color swatch to change, edit labels inline.
        </span>
        <div className={css.catList}>
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
        <div className={css.catActions}>
          <AddCategoryButton
            onAdd={(cat) => {
              onUpdate('bookmarkCategories', [...settings.bookmarkCategories, cat]);
            }}
            existingIds={settings.bookmarkCategories.map((c) => c.id)}
          />
          <Button
            variant="ghost"
            size="sm"
            className={css.linkBtn}
            type="button"
            onClick={() => onUpdate('bookmarkCategories', DEFAULT_BOOKMARK_CATEGORIES)}
          >
            Reset to defaults
          </Button>
        </div>
      </div>
    </>
  );
});

// ── MCP Integration section ───────────────────────────────────────────────

const McpIntegrationSection = memo(function McpIntegrationSection({ settings, onUpdate }: GeneralTabProps) {
  const { connState, port } = useMcpStatus();
  const [pending, setPending] = useState(false);

  const handleToggle = useCallback(async (checked: boolean) => {
    setPending(true);
    try {
      if (checked) {
        await startMcpBridge();
        onUpdate('mcpBridgeEnabled', true);
      } else {
        await stopMcpBridge();
        onUpdate('mcpBridgeEnabled', false);
      }
    } catch {
      // If start fails, don't persist the change
    } finally {
      setPending(false);
    }
  }, [onUpdate]);

  let statusText: string;
  let statusClass: string;
  switch (connState) {
    case 'connected':
      statusText = 'Bridge: connected';
      statusClass = css.mcpStatusConnected;
      break;
    case 'ready':
      statusText = `Bridge: ready on port ${port}`;
      statusClass = css.mcpStatusReady;
      break;
    case 'offline':
      statusText = 'Bridge: offline';
      statusClass = css.mcpStatusOffline;
      break;
    case 'disabled':
      statusText = 'Bridge: disabled';
      statusClass = css.mcpStatusChecking;
      break;
    default:
      statusText = 'Bridge: starting...';
      statusClass = css.mcpStatusChecking;
  }

  return (
    <div className={css.section}>
      <div className={css.sectionTitle}>MCP Integration</div>
      <div className={css.row}>
        <div className={css.label}>
          <span className={css.labelText}>HTTP Bridge</span>
          <span className={css.labelHint}>
            Runs a local server on port 40404 for AI agent integration.
          </span>
        </div>
        <div className={css.control}>
          <input
            type="checkbox"
            checked={settings.mcpBridgeEnabled}
            disabled={pending}
            onChange={(e) => handleToggle(e.target.checked)}
          />
        </div>
      </div>
      {settings.mcpBridgeEnabled && (
        <div className={css.mcpStatus}>
          <span className={`${css.mcpStatusDot} ${statusClass}`} />
          <span className={css.mcpStatusText}>{statusText}</span>
        </div>
      )}
    </div>
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
    <div className={css.catRow}>
      <div className={css.catSwatch} style={{ background: cat.color }}>
        <input
          type="color"
          className={css.catColorInput}
          value={cat.color}
          onChange={(e) => onUpdate({ ...cat, color: e.target.value })}
          title="Pick category color"
        />
      </div>
      <div className={css.catLabel}>
        <input
          type="text"
          className={css.catLabelInput}
          value={cat.label}
          onChange={(e) => onUpdate({ ...cat, label: e.target.value })}
          placeholder="Label"
        />
      </div>
      <span className={css.catId}>{cat.id}</span>
      {canDelete && (
        <IconButton
          icon={Trash2}
          size={12}
          type="button"
          className={css.catDeleteBtn}
          onClick={onDelete}
          title="Remove category"
        />
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
  const [newColor, setNewColor] = useState('var(--text-muted)');

  const handleSubmit = useCallback(() => {
    const id = newId.trim().toLowerCase().replace(/\s+/g, '-');
    if (!id || existingIds.includes(id)) return;
    onAdd({ id, label: newLabel.trim() || id, color: newColor });
    setNewId('');
    setNewLabel('');
    setNewColor('var(--text-muted)');
    setAdding(false);
  }, [newId, newLabel, newColor, existingIds, onAdd]);

  if (!adding) {
    return (
      <Button variant="ghost" size="sm" className={css.linkBtn} type="button" onClick={() => setAdding(true)}>
        <Plus size={12} /> Add category
      </Button>
    );
  }

  return (
    <div className={css.catAddForm}>
      <div className={`${css.catSwatch} ${css.catSwatchSm}`} style={{ background: newColor }}>
        <input
          type="color"
          className={css.catColorInput}
          value={newColor}
          onChange={(e) => setNewColor(e.target.value)}
        />
      </div>
      <input
        type="text"
        className={css.catAddInput}
        value={newId}
        onChange={(e) => setNewId(e.target.value)}
        placeholder="id (e.g. network)"
        autoFocus
        onKeyDown={(e) => { if (e.key === 'Enter') handleSubmit(); if (e.key === 'Escape') setAdding(false); }}
      />
      <input
        type="text"
        className={css.catAddInput}
        value={newLabel}
        onChange={(e) => setNewLabel(e.target.value)}
        placeholder="Display label"
        onKeyDown={(e) => { if (e.key === 'Enter') handleSubmit(); if (e.key === 'Escape') setAdding(false); }}
      />
      <Button variant="ghost" size="sm" className={css.linkBtn} type="button" onClick={handleSubmit}>Add</Button>
      <Button variant="ghost" size="sm" className={css.linkBtn} type="button" onClick={() => setAdding(false)}>Cancel</Button>
    </div>
  );
}

// -- File association settings (Windows 10/11) --------------------------------

const STATIC_ASSOCS = [
  { ext: '.lts', desc: 'LogTapper session' },
  { ext: '.ltw', desc: 'LogTapper workspace' },
];

function FileAssociationsSection() {
  const [entries, setEntries] = useState<FileAssocEntry[]>([]);
  const [pending, setPending] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);

  const refresh = useCallback(() => {
    getFileAssociationStatus()
      .then((e) => { setEntries(e); setLoaded(true); })
      .catch(() => { setLoaded(true); });
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  const handleToggle = useCallback(async (ext: string, enabled: boolean) => {
    setPending(ext);
    try {
      await setFileAssociation(ext, enabled);
      refresh();
    } catch {
      // Failed — leave unchanged
    } finally {
      setPending(null);
    }
  }, [refresh]);

  const handleOpenDefaults = useCallback(() => {
    openDefaultAppsSettings().catch(() => {});
  }, []);

  const isWindows = loaded && entries.length > 0;

  return (
    <div className={css.section}>
      <div className={css.sectionTitle}>File Associations</div>

      <span className={css.labelHint}>
        Registered automatically when LogTapper is installed.
      </span>
      {STATIC_ASSOCS.map(({ ext, desc }) => (
        <div className={css.assocStatic} key={ext}>
          <span className={css.assocStaticExt}>{ext}</span>
          <span className={css.assocStaticDesc}>{desc}</span>
          <span className={css.assocStaticBadge}>installed</span>
        </div>
      ))}

      {isWindows && (
        <>
          <span className={`${css.labelHint} ${css.labelHintTopGap}`}>
            Enable additional file types to open with LogTapper. Once enabled, set
            LogTapper as the default handler in Windows Settings.
          </span>
          {entries.map(({ ext, label, registered, isDefault }) => (
            <div className={css.row} key={ext}>
              <div className={css.label}>
                <span className={css.labelText}>{label} (.{ext})</span>
                {registered && (
                  <span
                    className={`${css.assocBadge} ${isDefault ? css.assocBadgeDefault : css.assocBadgeAvailable} ${css.assocBadgeMargin}`}
                  >
                    {isDefault ? 'Default handler' : 'Available in Open With'}
                  </span>
                )}
              </div>
              <div className={css.control}>
                <input
                  type="checkbox"
                  checked={registered}
                  disabled={pending === ext}
                  onChange={(e) => handleToggle(ext, e.target.checked)}
                />
              </div>
            </div>
          ))}
          <Button
            variant="secondary"
            size="sm"
            className={css.assocOpenSettings}
            type="button"
            onClick={handleOpenDefaults}
          >
            <ExternalLink size={11} />
            Windows Default Apps
          </Button>
        </>
      )}
    </div>
  );
}
