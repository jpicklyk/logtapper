import type { StateSnapshot } from '../bridge/types';

interface Props {
  snapshot: StateSnapshot | null;
  loading: boolean;
  isChanged: boolean;
  totalTransitions: number;
}

interface BlockedFeature {
  label: string;
  detail: string;
}

interface BlockedCategory {
  category: string;
  features: BlockedFeature[];
}

const BLOCKED_CATEGORIES: BlockedCategory[] = [
  {
    category: 'USB',
    features: [
      { label: 'USB command attacks',  detail: 'Blocks commands sent via cable' },
      { label: 'USB software install', detail: 'Prevents system software via USB' },
      { label: 'ADB access',           detail: 'Android Debug Bridge blocked' },
    ],
  },
  {
    category: 'Apps',
    features: [
      { label: 'App sideloading',  detail: 'Unknown source installs blocked' },
      { label: 'Keystring App',    detail: 'Diagnostic keystring access blocked' },
    ],
  },
  {
    category: 'Content',
    features: [
      { label: 'Malicious images', detail: 'Samsung Message Guard active' },
    ],
  },
];

export default function AutoBlockerCard({ snapshot, loading, isChanged, totalTransitions }: Props) {
  const isInitialized = snapshot?.initializedFields?.includes('enabled') ?? false;
  const enabled = isInitialized ? (snapshot?.fields?.enabled as boolean | null) : null;
  const source = snapshot?.fields?.source as string | undefined;

  const isActive = enabled === true;

  return (
    <div
      className={[
        'auto-blocker-card',
        isActive ? 'auto-blocker-active' : '',
        isChanged ? 'state-tracker-changed' : '',
      ]
        .filter(Boolean)
        .join(' ')}
    >
      {/* ── Header ─────────────────────────────────────────────────────── */}
      <div className="auto-blocker-header">
        <div className="auto-blocker-title-row">
          <svg className="auto-blocker-icon" viewBox="0 0 16 16" fill="none">
            <path
              d="M8 1.5L2.5 4v4c0 3.1 2.3 5.7 5.5 6.4 3.2-.7 5.5-3.3 5.5-6.4V4L8 1.5z"
              stroke="currentColor"
              strokeWidth="1.1"
              strokeLinejoin="round"
            />
            {isActive ? (
              <path
                d="M6 6l4 4M10 6l-4 4"
                stroke="currentColor"
                strokeWidth="1.2"
                strokeLinecap="round"
              />
            ) : (
              <path
                d="M5.5 8.5l1.5 1.5 3-3"
                stroke="currentColor"
                strokeWidth="1.2"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            )}
          </svg>
          <span className="auto-blocker-name">Auto Blocker</span>
          <span className="auto-blocker-subtitle">Samsung Security</span>
        </div>
        <div className="auto-blocker-header-right">
          {totalTransitions > 0 && (
            <span className="state-tracker-badge" title={`${totalTransitions} transitions in log`}>
              {totalTransitions}
            </span>
          )}
          {isChanged && <span className="state-tracker-pulse" />}
        </div>
      </div>

      {/* ── Skeleton ───────────────────────────────────────────────────── */}
      {loading && (
        <div className="state-skel-rows">
          {[60, 45, 55].map((w, i) => (
            <div key={i} className="state-skel-row">
              <div className="state-skel-key" style={{ width: `${w}%` }} />
              <div className="state-skel-val" style={{ width: `${100 - w - 20}%` }} />
            </div>
          ))}
        </div>
      )}

      {/* ── No data ────────────────────────────────────────────────────── */}
      {!loading && !snapshot && (
        <div className="state-tracker-no-data">Run the pipeline to see state</div>
      )}

      {/* ── Content ────────────────────────────────────────────────────── */}
      {!loading && snapshot && (
        <div className="auto-blocker-body">

          {/* Status badge */}
          <div
            className={[
              'auto-blocker-status',
              !isInitialized
                ? 'auto-blocker-status-unknown'
                : isActive
                ? 'auto-blocker-status-active'
                : 'auto-blocker-status-inactive',
            ]
              .filter(Boolean)
              .join(' ')}
          >
            <span className="auto-blocker-status-dot" />
            <span className="auto-blocker-status-label">
              {!isInitialized ? 'UNKNOWN' : isActive ? 'ACTIVE — SECURITY ENFORCED' : 'INACTIVE'}
            </span>
          </div>

          {/* Blocked feature grid — only when active */}
          {isActive && (
            <div className="auto-blocker-grid">
              {BLOCKED_CATEGORIES.map(({ category, features }) => (
                <div key={category} className="auto-blocker-grid-group">
                  <span className="auto-blocker-grid-category">{category}</span>
                  {features.map(({ label, detail }) => (
                    <div key={label} className="auto-blocker-grid-row" title={detail}>
                      <span className="auto-blocker-grid-label">{label}</span>
                      <span className="auto-blocker-grid-tag">BLOCKED</span>
                    </div>
                  ))}
                </div>
              ))}
            </div>
          )}

          {/* Safe message — only when inactive and known */}
          {!isActive && isInitialized && (
            <div className="auto-blocker-safe-msg">
              Developer tools accessible
            </div>
          )}

          {/* Detection source */}
          {source && (
            <div className="auto-blocker-source">
              {'detected via '}
              <span className="auto-blocker-source-value">{String(source)}</span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
