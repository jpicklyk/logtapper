import React from 'react';
import styles from './Input.module.css';

interface InputProps extends React.InputHTMLAttributes<HTMLInputElement> {
  prefixIcon?: React.ComponentType<{ size?: number }>;
  error?: boolean;
}

export const Input = React.memo<InputProps>(function Input({
  prefixIcon: PrefixIcon,
  error = false,
  className,
  ...rest
}) {
  const wrapCls = [styles.wrapper, error ? styles.error : '', className ?? '']
    .filter(Boolean)
    .join(' ');

  return (
    <div className={wrapCls}>
      {PrefixIcon && (
        <span className={styles.icon}>
          <PrefixIcon size={14} />
        </span>
      )}
      <input className={styles.input} {...rest} />
    </div>
  );
});
