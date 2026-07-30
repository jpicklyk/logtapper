import type { ReactNode } from 'react';
import { SessionDataProvider } from './SessionDataContext';
import { SessionActionsProvider } from './SessionActionsContext';
import { PaneSearchProvider } from './PaneSearchContext';

interface Props {
  sessionId: string | null;
  /**
   * Pane this subtree belongs to. Center panes pass their own id so search is
   * scoped to them; sidebar mounts omit it and get an inert search scope.
   */
  paneId?: string | null;
  children: ReactNode;
}

/** Combined per-session provider for data reads + mutation actions + pane search. */
export function SessionProviders({ sessionId, paneId = null, children }: Props) {
  return (
    <SessionDataProvider sessionId={sessionId}>
      <SessionActionsProvider sessionId={sessionId}>
        <PaneSearchProvider paneId={paneId} sessionId={sessionId}>
          {children}
        </PaneSearchProvider>
      </SessionActionsProvider>
    </SessionDataProvider>
  );
}
