import { memo, useState } from 'react';
import type { AppSettings, UseSettingsResult, UseAnonymizerConfigResult } from '../../hooks';
import { Modal } from '../../ui';
import { GeneralTab } from './GeneralTab';
import { PiiTab } from './PiiTab';
import css from './SettingsPanel.module.css';

type SettingsTab = 'general' | 'pii';

interface Props {
  settings: AppSettings;
  onUpdate: UseSettingsResult['updateSetting'];
  onReset: UseSettingsResult['resetSettings'];
  onClose: () => void;
  anonymizerConfig: UseAnonymizerConfigResult;
}

const SettingsPanel = memo(function SettingsPanel({
  settings,
  onUpdate,
  onReset,
  onClose,
  anonymizerConfig,
}: Props) {
  const [activeTab, setActiveTab] = useState<SettingsTab>('general');

  return (
    <Modal open onClose={onClose} width={580} noPadding>
      <div className={css.header}>
        <span className={css.title}>Settings</span>
        <button className={css.closeBtn} onClick={onClose}>
          x
        </button>
      </div>

      {/* Tab bar */}
      <div className={css.tabs}>
        <button
          className={`${css.tab}${activeTab === 'general' ? ` ${css.tabActive}` : ''}`}
          onClick={() => setActiveTab('general')}
        >
          General
        </button>
        <button
          className={`${css.tab}${activeTab === 'pii' ? ` ${css.tabActive}` : ''}`}
          onClick={() => setActiveTab('pii')}
        >
          PII Anonymization
        </button>
      </div>

      <div className={css.body}>
        {activeTab === 'general' && (
          <GeneralTab settings={settings} onUpdate={onUpdate} />
        )}
        {activeTab === 'pii' && (
          <PiiTab anonymizerConfig={anonymizerConfig} />
        )}
      </div>

      <div className={css.footer}>
        {activeTab === 'general' && (
          <button
            className={css.btnSecondary}
            onClick={onReset}
            title="Restore settings to their default values"
          >
            Reset to Defaults
          </button>
        )}
        <button className={css.btnPrimary} onClick={onClose}>
          Done
        </button>
      </div>
    </Modal>
  );
});

export default SettingsPanel;
