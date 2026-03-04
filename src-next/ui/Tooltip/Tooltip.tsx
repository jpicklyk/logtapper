import React from 'react';
import styles from './Tooltip.module.css';

interface TooltipProps {
  text: string;
  position?: 'top' | 'bottom' | 'left' | 'right';
  children: React.ReactNode;
}

export const Tooltip = React.memo<TooltipProps>(function Tooltip({
  text,
  position = 'top',
  children,
}) {
  return (
    <span className={`${styles.tooltip} ${styles[position]}`} data-tooltip={text}>
      {children}
    </span>
  );
});
