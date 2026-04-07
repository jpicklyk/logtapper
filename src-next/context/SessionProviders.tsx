import type { ReactNode } from 'react';
import { SessionDataProvider } from './SessionDataContext';
import { SessionActionsProvider } from './SessionActionsContext';

interface Props {
  sessionId: string | null;
  children: ReactNode;
}

/** Combined per-session provider for data reads + mutation actions. */
export function SessionProviders({ sessionId, children }: Props) {
  return (
    <SessionDataProvider sessionId={sessionId}>
      <SessionActionsProvider sessionId={sessionId}>
        {children}
      </SessionActionsProvider>
    </SessionDataProvider>
  );
}
