import React, { useState, useEffect } from 'react';
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

  return (
    <div className={css.root}>
      <div className={css.tabs}>
        {(['browse', 'updates', 'sources'] as SubTab[]).map((t) => (
          <button
            key={t}
            className={`${css.tab}${tab === t ? ` ${css.tabActive}` : ''}`}
            onClick={() => setTab(t)}
          >
            {t === 'browse' ? 'Browse' : t === 'updates' ? 'Updates' : 'Sources'}
            {t === 'updates' && marketplace.pendingUpdates.length > 0 && (
              <span className={css.tabCount}>{marketplace.pendingUpdates.length}</span>
            )}
            {t === 'sources' && marketplace.sources.length > 0 && (
              <span className={css.tabCount}>{marketplace.sources.length}</span>
            )}
          </button>
        ))}
      </div>

      <div className={css.body}>
        {tab === 'browse' && <BrowseTab marketplace={marketplace} />}
        {tab === 'updates' && <UpdatesTab marketplace={marketplace} />}
        {tab === 'sources' && <SourcesTab marketplace={marketplace} />}
      </div>
    </div>
  );
});
