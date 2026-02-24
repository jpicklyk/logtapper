import React from 'react';
import { Spinner } from '../Spinner/Spinner';
import styles from './Button.module.css';

interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'secondary' | 'danger' | 'ghost';
  size?: 'sm' | 'md';
  loading?: boolean;
}

export const Button = React.memo<ButtonProps>(function Button({
  variant = 'secondary',
  size = 'md',
  loading = false,
  disabled,
  className,
  children,
  ...rest
}) {
  const cls = [
    styles.button,
    styles[variant],
    styles[size],
    loading ? styles.loading : '',
    className ?? '',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <button className={cls} disabled={disabled || loading} {...rest}>
      {loading && <Spinner size={size === 'sm' ? 12 : 14} />}
      <span className={loading ? styles.labelHidden : undefined}>{children}</span>
    </button>
  );
});
