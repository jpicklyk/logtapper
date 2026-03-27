import React, { useCallback } from 'react';
import clsx from 'clsx';
import styles from './SegmentedControl.module.css';

export interface SegmentedOption<T extends string> {
  value: T;
  icon: React.ComponentType<{ size?: number | string }>;
  tooltip: string;
}

interface SegmentedControlProps<T extends string> {
  options: SegmentedOption<T>[];
  value: T;
  onChange: (value: T) => void;
  size?: 'sm' | 'md';
}

function SegmentedControlInner<T extends string>({
  options,
  value,
  onChange,
  size = 'sm',
}: SegmentedControlProps<T>) {
  return (
    <div className={clsx(styles.root, styles[size])} role="group">
      {options.map((opt) => (
        <SegmentedButton
          key={opt.value}
          option={opt}
          active={opt.value === value}
          onChange={onChange}
        />
      ))}
    </div>
  );
}

interface SegmentedButtonProps<T extends string> {
  option: SegmentedOption<T>;
  active: boolean;
  onChange: (value: T) => void;
}

const SegmentedButton = React.memo(function SegmentedButton<T extends string>({
  option,
  active,
  onChange,
}: SegmentedButtonProps<T>) {
  const Icon = option.icon;
  const handleClick = useCallback(() => {
    onChange(option.value);
  }, [onChange, option.value]);

  return (
    <button
      className={clsx(styles.button, active && styles.active)}
      onClick={handleClick}
      title={option.tooltip}
      type="button"
      aria-pressed={active}
    >
      <Icon size={14} />
    </button>
  );
}) as <T extends string>(props: SegmentedButtonProps<T>) => React.ReactElement;

export const SegmentedControl = React.memo(SegmentedControlInner) as <T extends string>(
  props: SegmentedControlProps<T>,
) => React.ReactElement;
