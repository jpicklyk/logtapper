import React from 'react';
import styles from './Badge.module.css';

export type BadgeColor = 'blue' | 'green' | 'red' | 'yellow' | 'gray';

interface BadgeProps {
  label: string;
  color?: BadgeColor;
  pulse?: boolean;
}

export const Badge = React.memo<BadgeProps>(function Badge({
  label,
  color = 'gray',
  pulse = false,
}) {
  const cls = [styles.badge, styles[color], pulse ? styles.pulse : '']
    .filter(Boolean)
    .join(' ');

  return <span className={cls}>{label}</span>;
});
