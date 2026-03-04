import React from 'react';
import styles from './Badge.module.css';

interface BadgeProps {
  label: string;
  color?: 'blue' | 'green' | 'red' | 'yellow' | 'gray';
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
