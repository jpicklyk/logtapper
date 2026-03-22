import React from 'react';

interface IconProps {
  size?: number;
  className?: string;
}

// Reporter — magnifying glass (searches/extracts data)
export const ReporterIcon: React.FC<IconProps> = ({ size = 14, className }) => (
  <svg width={size} height={size} viewBox="0 0 16 16" fill="none" className={className}>
    <circle cx="6.5" cy="6.5" r="4" stroke="currentColor" strokeWidth="1.5" />
    <line x1="9.5" y1="9.5" x2="13.5" y2="13.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
  </svg>
);

// StateTracker — clock (tracks state over time)
export const StateTrackerIcon: React.FC<IconProps> = ({ size = 14, className }) => (
  <svg width={size} height={size} viewBox="0 0 16 16" fill="none" className={className}>
    <circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="1.5" />
    <polyline points="8,4.5 8,8 10.5,10" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

// Correlator — link/chain (correlates events across sources)
export const CorrelatorIcon: React.FC<IconProps> = ({ size = 14, className }) => (
  <svg width={size} height={size} viewBox="0 0 16 16" fill="none" className={className}>
    <path d="M6 10l-1.5 1.5a2.121 2.121 0 0 0 3 3L9 13" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    <path d="M10 6l1.5-1.5a2.121 2.121 0 0 0-3-3L7 3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    <line x1="6" y1="10" x2="10" y2="6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
  </svg>
);

// Transformer — funnel (filters/transforms log lines)
export const TransformerIcon: React.FC<IconProps> = ({ size = 14, className }) => (
  <svg width={size} height={size} viewBox="0 0 16 16" fill="none" className={className}>
    <path d="M2 3h12l-4.5 5.5V13l-3-1.5V8.5L2 3z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
  </svg>
);

// Annotator — tag/label (annotates lines)
export const AnnotatorIcon: React.FC<IconProps> = ({ size = 14, className }) => (
  <svg width={size} height={size} viewBox="0 0 16 16" fill="none" className={className}>
    <path d="M2 2h7l5 6-5 6H2V2z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
    <circle cx="5.5" cy="8" r="1" fill="currentColor" />
  </svg>
);

// Unified component that selects icon by type string
export const ProcessorTypeIcon: React.FC<IconProps & { type: string }> = ({ type, ...props }) => {
  switch (type) {
    case 'reporter': return <ReporterIcon {...props} />;
    case 'state_tracker': return <StateTrackerIcon {...props} />;
    case 'correlator': return <CorrelatorIcon {...props} />;
    case 'transformer': return <TransformerIcon {...props} />;
    case 'annotator': return <AnnotatorIcon {...props} />;
    default: return null;
  }
};
