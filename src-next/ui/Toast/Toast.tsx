import React from 'react';
import { createPortal } from 'react-dom';
import styles from './Toast.module.css';

export interface ToastItem {
  id: string;
  title: string;
  message: string;
  onClick?: () => void;
}

interface ToastProps {
  toasts: ToastItem[];
  onDismiss: (id: string) => void;
}

export const Toast = React.memo(function Toast({ toasts, onDismiss }: ToastProps) {
  if (toasts.length === 0) return null;

  return createPortal(
    <div className={styles.container}>
      {toasts.map((toast) => (
        <div
          key={toast.id}
          className={styles.toast}
          data-clickable={toast.onClick ? 'true' : undefined}
          onClick={toast.onClick}
          role={toast.onClick ? 'button' : undefined}
          tabIndex={toast.onClick ? 0 : undefined}
          onKeyDown={toast.onClick ? (e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              toast.onClick!();
            }
          } : undefined}
        >
          <div className={styles.indicator}>
            <span className={styles.pulse} />
            <span className={styles.title}>{toast.title}</span>
          </div>
          <div className={styles.message}>{toast.message}</div>
          <button
            className={styles.close}
            onClick={(e) => {
              e.stopPropagation();
              onDismiss(toast.id);
            }}
            aria-label="Dismiss"
          >
            &#x2715;
          </button>
        </div>
      ))}
    </div>,
    document.body,
  );
});
