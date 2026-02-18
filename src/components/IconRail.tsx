import type { RightTool } from '../hooks/usePaneLayout';

interface RailItem {
  tool: RightTool;
  icon: string;
  label: string;
}

const RAIL_ITEMS: RailItem[] = [
  { tool: 'processors',  icon: '⚙',  label: 'Processors' },
  { tool: 'chat',        icon: '✦',  label: 'AI Chat' },
  { tool: 'marketplace', icon: '◫',  label: 'Marketplace' },
];

interface Props {
  activeTool: RightTool | null;
  onToggle: (tool: RightTool) => void;
}

export default function IconRail({ activeTool, onToggle }: Props) {
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
    </div>
  );
}
