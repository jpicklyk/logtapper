import React from 'react';

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
    <span aria-hidden="true" style={{ display: 'inline-flex', alignItems: 'center' }}>
      <IconComponent size={size} className={className} />
    </span>
  );
});
