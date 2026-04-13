import React, { useEffect, useMemo, useRef, useState } from 'react';
import type { Viewport } from './timelineUtils';
import { linePct, niceLineStep } from './timelineUtils';
import styles from './LineRuler.module.css';

export interface LineRulerProps {
  vp: Viewport;
  totalLines: number;
  onPan: (deltaNorm: number) => void;
}

const LineRuler = React.memo(function LineRuler({ vp, totalLines, onPan }: LineRulerProps) {
  const bodyRef = useRef<HTMLDivElement>(null);
  const [bodyW, setBodyW] = useState(0);

  useEffect(() => {
    const el = bodyRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setBodyW(e.contentRect.width));
    ro.observe(el);
    setBodyW(el.clientWidth);
    return () => ro.disconnect();
  }, []);

  const [vpS, vpE] = vp;
  const vpSpan = Math.max(vpE - vpS, 1e-9);
  const maxLine = Math.max(totalLines - 1, 1);

  const normPct = (norm: number) => linePct(norm * maxLine, maxLine, vpS, vpSpan);

  const lineTicks = useMemo(() => {
    const visMinLine = vpS * maxLine;
    const visDurLine = vpSpan * maxLine;
    const count = Math.max(2, Math.floor(bodyW / 70));
    const step = niceLineStep(visDurLine / count);
    const first = Math.ceil(visMinLine / step) * step;
    const result: { norm: number; label: string }[] = [];
    for (let ln = first; ln <= visMinLine + visDurLine; ln += step) {
      result.push({ norm: ln / maxLine, label: (ln + 1).toLocaleString() });
      if (result.length > 200) break;
    }
    return result;
  }, [vpS, vpSpan, maxLine, bodyW]);

  const onMouseDown = (e: React.MouseEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    let lastX = e.clientX;
    const w = bodyRef.current?.getBoundingClientRect().width ?? 1;
    const span = vpSpan;
    const onMove = (ev: MouseEvent) => {
      const dx = ev.clientX - lastX;
      lastX = ev.clientX;
      onPan(-(dx / w) * span);
    };
    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };

  return (
    <div className={styles.ruler}>
      <div className={styles.rulerSpacer}>
        <div className={styles.rulerAxisLabel}>Line #</div>
      </div>
      <div className={styles.rulerBody} ref={bodyRef} onMouseDown={onMouseDown}>
        <div className={styles.rulerRow}>
          {lineTicks.map((tick, i) => (
            <div
              key={i}
              className={styles.rulerTick}
              style={{ '--tick-pos': normPct(tick.norm) } as React.CSSProperties}
            >
              <span className={styles.rulerLabel}>{tick.label}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
});

export default LineRuler;
