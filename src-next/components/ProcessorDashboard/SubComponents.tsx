import React, { useState, type ReactNode } from 'react';
import { ChevronRight } from 'lucide-react';
import { formatNumber, snakeToTitle, splitValueDesc } from './utils';
import styles from './ProcessorDashboard.module.css';

// ── Collapsible section wrapper ──────────────────────────────────────────────

export const CollapsibleSection = React.memo(function CollapsibleSection({
  label,
  children,
  defaultOpen = true,
}: {
  label: string;
  children: ReactNode;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className={`${styles.section} ${open ? '' : styles.sectionCollapsed}`}>
      <div
        className={styles.sectionLabel}
        onClick={() => setOpen((v) => !v)}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setOpen((v) => !v); } }}
      >
        <ChevronRight
          size={10}
          className={`${styles.sectionChevron} ${open ? styles.sectionChevronOpen : ''}`}
        />
        {label}
      </div>
      {open && <div className={styles.sectionContent}>{children}</div>}
    </div>
  );
});

// ── StatCard ─────────────────────────────────────────────────────────────────

export const StatCard = React.memo(function StatCard({ label, value }: { label: string; value: number }) {
  return (
    <div className={styles.statCard}>
      <span className={styles.statValue}>{formatNumber(value)}</span>
      <span className={styles.statLabel}>{snakeToTitle(label)}</span>
    </div>
  );
});

// ── RankedList ────────────────────────────────────────────────────────────────

export const RankedList = React.memo(function RankedList({
  name,
  label,
  value,
}: {
  name: string;
  label?: string;
  value: Record<string, number>;
}) {
  const sorted = Object.entries(value)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 15);
  const max = sorted[0]?.[1] ?? 1;
  return (
    <CollapsibleSection label={label ?? snakeToTitle(name)}>
      <div className={styles.rankedList}>
        {sorted.map(([k, v]) => (
          <div key={k} className={styles.rankedRow}>
            <span className={styles.rankedKey} title={k}>
              {k}
            </span>
            <div className={styles.rankedBarWrap}>
              <div
                className={styles.rankedBar}
                style={{ width: `${(v / max) * 100}%` }}
              />
            </div>
            <span className={styles.rankedVal}>{formatNumber(v)}</span>
          </div>
        ))}
      </div>
    </CollapsibleSection>
  );
});

// ── DataTable ─────────────────────────────────────────────────────────────────

export const DataTable = React.memo(function DataTable({
  name,
  label,
  value,
}: {
  name: string;
  label?: string;
  value: Record<string, unknown>[];
}) {
  const keys = Object.keys(value[0] ?? {});

  // Check once whether any cell uses the annotated "val | desc" format.
  const hasAnnotated = value.some((row) =>
    Object.values(row).some((v) => String(v ?? '').includes(' | ')),
  );

  return (
    <CollapsibleSection label={label ?? snakeToTitle(name)}>
      <div className={styles.tableWrap}>
        <table className={styles.dataTable}>
          <thead>
            <tr>
              {keys.map((k) => (
                <th key={k}>{k}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {value.slice(0, 100).map((row, i) => (
              <tr key={i}>
                {keys.map((k, ki) => {
                  const raw = String(row[k] ?? '');
                  const split = hasAnnotated ? splitValueDesc(raw) : null;

                  if (split) {
                    return (
                      <td key={k} className={styles.tdValueDesc}>
                        <span className={styles.valueBadge}>{split.value}</span>
                        <span className={styles.valueDesc}>{split.desc}</span>
                      </td>
                    );
                  }

                  // In annotated tables, style the key column as a dim mono identifier.
                  if (hasAnnotated && ki === 0) {
                    return (
                      <td key={k} className={styles.tdParamKey}>
                        {raw}
                      </td>
                    );
                  }

                  return <td key={k}>{raw}</td>;
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </CollapsibleSection>
  );
});
