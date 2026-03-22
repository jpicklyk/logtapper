import React from 'react';
import type { ProcessorSummary } from '../../bridge/types';
import { ProcessorTypeIcon, getCategoryLabel, PROC_TYPE_DESCRIPTIONS, PROC_TYPE_LABELS } from '../../ui';
import styles from './ProcessorDetailCard.module.css';

interface ProcessorDetailCardProps {
  processor: ProcessorSummary;
}

export const ProcessorDetailCard: React.FC<ProcessorDetailCardProps> = React.memo(
  function ProcessorDetailCard({ processor }) {
    const typeLabel = PROC_TYPE_LABELS[processor.processorType] ?? processor.processorType;
    const typeDesc = PROC_TYPE_DESCRIPTIONS[processor.processorType];
    const categoryLabel = getCategoryLabel(processor.category);

    const hasVars = processor.varsMeta && processor.varsMeta.length > 0;

    return (
      <div className={styles.card}>
        {/* Type + Category row */}
        <div className={styles.typeCategoryRow}>
          <ProcessorTypeIcon type={processor.processorType} size={14} className={styles.typeIconSmall} />
          <span className={styles.typeLabel}>{typeLabel}</span>
          <span className={styles.separator}>·</span>
          <span className={styles.categoryLabel}>{categoryLabel}</span>
        </div>

        {/* Type description */}
        {typeDesc && (
          <div className={styles.typeDesc}>{typeDesc}</div>
        )}

        {/* Meta row: version, author, license */}
        <div className={styles.metaRow}>
          <span className={styles.versionBadge}>v{processor.version}</span>
          {processor.source && (
            <>
              <span className={styles.metaSep}>·</span>
              <span className={styles.metaItem}>{processor.source}</span>
            </>
          )}
          {processor.license && (
            <>
              <span className={styles.metaSep}>·</span>
              <span className={styles.metaItem}>{processor.license}</span>
            </>
          )}
          {processor.hasSchema && (
            <>
              <span className={styles.metaSep}>·</span>
              <span className={styles.schemaBadge}>Schema Contract</span>
            </>
          )}
        </div>

        {/* Full description */}
        {processor.description && (
          <div className={styles.description}>{processor.description}</div>
        )}

        {/* Tags */}
        {processor.tags.length > 0 && (
          <div className={styles.tags}>
            {processor.tags.map((tag) => (
              <span key={tag} className={styles.tag}>{tag}</span>
            ))}
          </div>
        )}

        {/* Variables section */}
        {hasVars && (
          <div className={styles.varsSection}>
            <div className={styles.sectionHeader}>Variables</div>
            <div className={styles.varsList}>
              {processor.varsMeta.map((v) => (
                <div key={v.name} className={styles.varRow}>
                  <span className={styles.varName}>{v.label || v.name}</span>
                  {v.displayAs && (
                    <span className={styles.varType}>{v.displayAs}</span>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    );
  },
);
