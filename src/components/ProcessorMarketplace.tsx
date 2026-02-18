import { useCallback, useState } from 'react';
import type { RegistryEntry } from '../bridge/types';
import { fetchRegistry, installFromRegistry } from '../bridge/commands';
import type { PipelineState } from '../hooks/usePipeline';

interface Props {
  pipeline: PipelineState;
}

type InstallStatus = 'idle' | 'installing' | 'installed' | 'error';

export default function ProcessorMarketplace({ pipeline }: Props) {
  const [entries, setEntries] = useState<RegistryEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [installStatus, setInstallStatus] = useState<Record<string, InstallStatus>>({});
  const [installError, setInstallError] = useState<Record<string, string>>({});
  const [filter, setFilter] = useState('');

  const installedIds = new Set(pipeline.processors.map((p) => p.id));

  const handleFetch = useCallback(async () => {
    setLoading(true);
    setFetchError(null);
    try {
      const result = await fetchRegistry();
      setEntries(result);
    } catch (err) {
      setFetchError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  const handleInstall = useCallback(
    async (entry: RegistryEntry) => {
      setInstallStatus((s) => ({ ...s, [entry.id]: 'installing' }));
      setInstallError((e) => {
        const next = { ...e };
        delete next[entry.id];
        return next;
      });
      try {
        await installFromRegistry(entry);
        await pipeline.loadProcessors();
        setInstallStatus((s) => ({ ...s, [entry.id]: 'installed' }));
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        setInstallStatus((s) => ({ ...s, [entry.id]: 'error' }));
        setInstallError((e) => ({ ...e, [entry.id]: msg }));
      }
    },
    [pipeline],
  );

  const filteredEntries = entries.filter((e) => {
    if (!filter) return true;
    const q = filter.toLowerCase();
    return (
      e.name.toLowerCase().includes(q) ||
      (e.description ?? '').toLowerCase().includes(q) ||
      e.tags.some((t) => t.toLowerCase().includes(q))
    );
  });

  return (
    <div className="marketplace">
      <div className="marketplace-header">
        <span className="marketplace-title">Processor Marketplace</span>
        <button
          className="btn-primary"
          onClick={handleFetch}
          disabled={loading}
        >
          {loading ? 'Fetching…' : entries.length > 0 ? 'Refresh' : 'Fetch from GitHub'}
        </button>
      </div>

      {fetchError && (
        <div className="marketplace-error">
          <strong>Error:</strong> {fetchError}
        </div>
      )}

      {entries.length > 0 && (
        <div className="marketplace-filter">
          <input
            className="marketplace-filter-input"
            type="text"
            placeholder="Filter processors…"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          />
        </div>
      )}

      {entries.length === 0 && !loading && !fetchError && (
        <div className="marketplace-empty">
          Click <strong>Fetch from GitHub</strong> to browse available processors.
        </div>
      )}

      <div className="marketplace-list">
        {filteredEntries.map((entry) => {
          const status = installStatus[entry.id] ?? 'idle';
          const alreadyInstalled = installedIds.has(entry.id);

          return (
            <div key={entry.id} className="marketplace-item">
              <div className="marketplace-item-info">
                <div className="marketplace-item-name">{entry.name}</div>
                <div className="marketplace-item-version">v{entry.version}</div>
                {entry.description && (
                  <div className="marketplace-item-desc">{entry.description}</div>
                )}
                <div className="marketplace-item-tags">
                  {entry.tags.map((tag) => (
                    <span key={tag} className="marketplace-tag">
                      {tag}
                    </span>
                  ))}
                </div>
                {installError[entry.id] && (
                  <div className="marketplace-item-error">
                    {installError[entry.id]}
                  </div>
                )}
              </div>
              <div className="marketplace-item-action">
                {alreadyInstalled || status === 'installed' ? (
                  <span className="marketplace-installed-badge">✓ Installed</span>
                ) : (
                  <button
                    className="btn-primary"
                    onClick={() => handleInstall(entry)}
                    disabled={status === 'installing'}
                  >
                    {status === 'installing' ? 'Installing…' : 'Install'}
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
