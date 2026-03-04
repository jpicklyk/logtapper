import { useWorkspaceLayout } from './hooks';
import { AppShell } from './layout/AppShell';
import './styles/animations.css';
import './styles/highlights.css';

/**
 * Root application component.
 * No hooks, no orchestration effects — just instantiates the workspace layout
 * and passes it to AppShell. All cross-hook coordination happens via the event bus.
 */
export default function App() {
  const workspace = useWorkspaceLayout();

  return <AppShell workspace={workspace} />;
}
