import React, { useState, useCallback, useEffect } from 'react';
import { useMarketplace } from '../../hooks';
import { BrowseTab } from './BrowseTab';
import { UpdatesTab } from './UpdatesTab';
import { SourcesTab } from './SourcesTab';
import css from './MarketplacePanel.module.css';

type SubTab = 'browse' | 'updates' | 'sources';

export const MarketplacePanel = React.memo(function MarketplacePanel() {
  const marketplace = useMarketplace();
  const [tab, setTab] = useState<SubTab>('browse');

  useEffect(() => {
    marketplace.loadSources();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const switchTab = useCallback((t: SubTab) => setTab(t), []);

  return (
    <div className={css.root}>
      <div className={css.tabs}>
        {(['browse', 'updates', 'sources'] as SubTab[]).map((t) => (
          <button
            key={t}
            className={`${css.tab}${tab === t ? ` ${css.tabActive}` : ''}`}
            onClick={() => switchTab(t)}
          >
            {t === 'browse' ? 'Browse' : t === 'updates' ? 'Updates' : 'Sources'}
            {t === 'updates' && marketplace.pendingUpdateCount > 0 && (
              <span className={css.tabCount}>{marketplace.pendingUpdateCount}</span>
            )}
            {t === 'sources' && marketplace.sources.length > 0 && (
              <span className={css.tabCount}>{marketplace.sources.length}</span>
            )}
          </button>
        ))}
      </div>

      <div className={css.body}>
        {tab === 'browse' && (
          <BrowseTab
            sources={marketplace.sources}
            selectedSource={marketplace.selectedSource}
            selectSource={marketplace.selectSource}
            entries={marketplace.entries}
            entriesLoading={marketplace.entriesLoading}
            entriesError={marketplace.entriesError}
            fetchEntries={marketplace.fetchEntries}
            installEntry={marketplace.installEntry}
          />
        )}
        {tab === 'updates' && (
          <UpdatesTab
            pendingUpdates={marketplace.pendingUpdates}
            updatesLoading={marketplace.updatesLoading}
            updateResults={marketplace.updateResults}
            checkUpdates={marketplace.checkUpdates}
            updateOne={marketplace.updateOne}
            updateAllFromSource={marketplace.updateAllFromSource}
          />
        )}
        {tab === 'sources' && (
          <SourcesTab
            sources={marketplace.sources}
            addSource={marketplace.addSource}
            removeSource={marketplace.removeSource}
          />
        )}
      </div>
    </div>
  );
});
