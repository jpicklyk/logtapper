import type { RightTool } from '../hooks/usePaneLayout';

interface RailItem {
  tool: RightTool;
  icon: string;
  label: string;
}

const RAIL_ITEMS: RailItem[] = [
  { tool: 'processors',  icon: '≋',  label: 'Processors' },
  { tool: 'marketplace', icon: '⊞',  label: 'Marketplace' },
];

interface Props {
  activeTool: RightTool | null;
  onToggle: (tool: RightTool) => void;
  onOpenSettings: () => void;
}

export default function IconRail({ activeTool, onToggle, onOpenSettings }: Props) {
  return (
    <div className="icon-rail">
      {RAIL_ITEMS.map(({ tool, icon, label }) => (
        <button
          key={tool}
          className={`icon-rail-btn${activeTool === tool ? ' icon-rail-btn--active' : ''}`}
          data-tooltip={label}
          aria-label={label}
          aria-pressed={activeTool === tool}
          onClick={() => onToggle(tool)}
        >
          <span className="icon-rail-icon">{icon}</span>
        </button>
      ))}
      <button
        className="icon-rail-btn"
        style={{ marginTop: 'auto' }}
        data-tooltip="Settings"
        aria-label="Open Settings"
        onClick={onOpenSettings}
      >
        <span className="icon-rail-icon">⚙</span>
      </button>
    </div>
  );
}
