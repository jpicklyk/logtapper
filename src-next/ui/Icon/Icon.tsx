import React from 'react';
import styles from './Icon.module.css';

interface IconProps {
  icon: React.ComponentType<{ size?: number; className?: string }>;
  size?: number;
  className?: string;
}

export const Icon = React.memo<IconProps>(function Icon({
  icon: IconComponent,
  size = 16,
  className,
}) {
  return (
    <span aria-hidden="true" className={styles.icon}>
      <IconComponent size={size} className={className} />
    </span>
  );
});
