import { memo, useState } from 'react';
import type { AppSettings, UseSettingsResult, UseAnonymizerConfigResult } from '../../hooks';
import { Modal, Button } from '../../ui';
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
        <Button variant="ghost" size="sm" className={css.closeBtn} onClick={onClose}>
          x
        </Button>
      </div>

      {/* Tab bar */}
      <div className={css.tabs}>
        <Button
          variant="ghost"
          size="sm"
          className={`${css.tab}${activeTab === 'general' ? ` ${css.tabActive}` : ''}`}
          onClick={() => setActiveTab('general')}
        >
          General
        </Button>
        <Button
          variant="ghost"
          size="sm"
          className={`${css.tab}${activeTab === 'pii' ? ` ${css.tabActive}` : ''}`}
          onClick={() => setActiveTab('pii')}
        >
          PII Anonymization
        </Button>
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
          <Button
            variant="secondary"
            size="sm"
            className={css.btnSecondary}
            onClick={onReset}
            title="Restore settings to their default values"
          >
            Reset to Defaults
          </Button>
        )}
        <Button variant="primary" size="sm" className={css.btnPrimary} onClick={onClose}>
          Done
        </Button>
      </div>
    </Modal>
  );
});

export default SettingsPanel;
