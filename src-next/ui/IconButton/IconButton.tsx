import React from 'react';
import styles from './IconButton.module.css';

interface IconButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  icon: React.ComponentType<{ size?: number | string }>;
  size?: number;
  active?: boolean;
  title?: string;
}

export const IconButton = React.memo<IconButtonProps>(function IconButton({
  icon: IconComponent,
  size = 16,
  active = false,
  className,
  title,
  ...rest
}) {
  if (import.meta.env.DEV && !title && !(rest as React.ButtonHTMLAttributes<HTMLButtonElement>)['aria-label']) {
    console.warn('IconButton: provide a `title` or `aria-label` for screen reader accessibility.');
  }

  const cls = [styles.iconButton, active ? styles.active : '', className ?? '']
    .filter(Boolean)
    .join(' ');

  return (
    <button className={cls} title={title} {...rest}>
      <IconComponent size={size} />
    </button>
  );
});
