import React from 'react';
import styles from './Spinner.module.css';

interface SpinnerProps {
  size?: number;
}

export const Spinner = React.memo<SpinnerProps>(function Spinner({ size = 16 }) {
  return (
    <span
      className={styles.spinner}
      style={{ width: size, height: size, borderWidth: Math.max(2, size / 8) }}
      role="status"
      aria-label="Loading"
    />
  );
});
