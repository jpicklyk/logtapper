import { useCallback, useEffect, useRef, useState } from 'react';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Tab types that appear in the central pane area. */
export type TabType = 'logviewer' | 'dashboard' | 'scratch';

/** Tool types shown in the right tool window, controlled by the icon rail. */
export type RightTool = 'processors' | 'chat' | 'marketplace';

export type LayoutPreset = 'compact' | 'standard' | 'wide';

export interface PaneTab {
  id: string;
  type: TabType;
  label: string;
}

export interface Pane {
  id: string;
  tabs: PaneTab[];
  activeTabId: string;
  flexBasis: number; // 0..1 fraction of center pane area width
}

export interface PaneLayoutState {
  panes: Pane[];
  preset: LayoutPreset;
  /** Ref for the outer workspace div — used by ResizeObserver for preset detection. */
  containerRef: React.RefObject<HTMLDivElement>;
  /** Ref for the center pane-area div — used to compute fraction deltas when resizing. */
  centerRef: React.RefObject<HTMLDivElement>;
  moveTab: (tabId: string, fromPaneId: string, toPaneId: string) => void;
  splitRight: (tabId: string, fromPaneId: string) => void;
  closeTab: (tabId: string, paneId: string) => void;
  setActiveTab: (tabId: string, paneId: string) => void;
  addTab: (paneId: string, type: TabType) => void;
  resizePane: (paneId: string, deltaFraction: number) => void;
  // Sidebar / tool window
  leftSidebarWidth: number;
  rightTool: RightTool | null;
  rightPanelWidth: number;
  toggleRightTool: (tool: RightTool) => void;
  resizeLeftSidebar: (delta: number) => void;
  resizeRightPanel: (delta: number) => void;
  /**
   * Open a tab of the given type in the center area.
   * - If a tab of that type already exists in any pane, activates it.
   * - If there is only one center pane, splits it right and puts the new tab in the right pane.
   * - If there are multiple center panes, adds/activates in the last (rightmost) pane.
   */
  openCenterTab: (type: TabType) => void;
  resetLayout: () => void;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const PANES_KEY = 'logtapper_panes_v2'; // v2: center-only tab types (no fileinfo/processors/chat/marketplace)
const SHELL_KEY = 'logtapper_shell_v1';
const MIN_FLEX = 0.10;

const MIN_LEFT_WIDTH = 140;
const MAX_LEFT_WIDTH = 420;
const DEFAULT_LEFT_WIDTH = 220;

const MIN_RIGHT_WIDTH = 220;
const MAX_RIGHT_WIDTH = 600;
const DEFAULT_RIGHT_WIDTH = 300;

export const TAB_LABELS: Record<TabType, string> = {
  logviewer: 'Log',
  dashboard: 'Dashboard',
  scratch: 'Scratch',
};

function makeTab(type: TabType): PaneTab {
  return { id: crypto.randomUUID(), type, label: TAB_LABELS[type] };
}

function makePane(tabs: TabType[], flexBasis: number): Pane {
  const paneTabs = tabs.map(makeTab);
  return {
    id: crypto.randomUUID(),
    tabs: paneTabs,
    activeTabId: paneTabs[0]?.id ?? '',
    flexBasis,
  };
}

// ---------------------------------------------------------------------------
// Default layouts per preset
// ---------------------------------------------------------------------------

function defaultPanes(_preset: LayoutPreset): Pane[] {
  // All presets start with a single logviewer pane; users split as needed.
  return [makePane(['logviewer'], 1.0)];
}

// ---------------------------------------------------------------------------
// localStorage persistence
// ---------------------------------------------------------------------------

interface PersistedPanes {
  standard?: Pane[];
  wide?: Pane[];
}

interface PersistedShell {
  leftSidebarWidth?: number;
  rightTool?: RightTool | null;
  rightPanelWidth?: number;
}

const VALID_TAB_TYPES = new Set<string>(['logviewer', 'dashboard', 'scratch']);

/** Strip tabs with tab types that no longer exist (e.g. from a previous schema). */
function sanitizePanes(panes: Pane[]): Pane[] {
  return panes
    .map((pane) => {
      const tabs = pane.tabs.filter((t) => VALID_TAB_TYPES.has(t.type));
      if (tabs.length === 0) return null;
      const activeTabId = tabs.find((t) => t.id === pane.activeTabId)
        ? pane.activeTabId
        : tabs[0].id;
      return { ...pane, tabs, activeTabId };
    })
    .filter((p): p is Pane => p !== null);
}

function loadPanes(): PersistedPanes {
  try {
    const raw = localStorage.getItem(PANES_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as PersistedPanes;
    return {
      standard: parsed.standard ? sanitizePanes(parsed.standard) : undefined,
      wide: parsed.wide ? sanitizePanes(parsed.wide) : undefined,
    };
  } catch {
    return {};
  }
}

function savePanes(preset: LayoutPreset, panes: Pane[]): void {
  if (preset === 'compact') return;
  try {
    const current = loadPanes();
    localStorage.setItem(PANES_KEY, JSON.stringify({ ...current, [preset]: panes }));
  } catch { /* storage full */ }
}

function loadShell(): PersistedShell {
  try {
    const raw = localStorage.getItem(SHELL_KEY);
    if (!raw) return {};
    return JSON.parse(raw) as PersistedShell;
  } catch {
    return {};
  }
}

function saveShell(shell: PersistedShell): void {
  try {
    localStorage.setItem(SHELL_KEY, JSON.stringify(shell));
  } catch { /* storage full */ }
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export function usePaneLayout(): PaneLayoutState {
  const containerRef = useRef<HTMLDivElement>(null);
  const centerRef = useRef<HTMLDivElement>(null);
  const [preset, setPreset] = useState<LayoutPreset>('standard');
  const presetRef = useRef<LayoutPreset>('standard');

  // Center panes
  const [panes, setPanes] = useState<Pane[]>(() => {
    const saved = loadPanes();
    return saved.standard ?? defaultPanes('standard');
  });
  const panesRef = useRef<Pane[]>(panes);

  // Shell state (sidebar/right panel)
  const savedShell = loadShell();
  const [leftSidebarWidth, setLeftSidebarWidth] = useState(
    savedShell.leftSidebarWidth ?? DEFAULT_LEFT_WIDTH,
  );
  const [rightTool, setRightTool] = useState<RightTool | null>(
    savedShell.rightTool ?? null,
  );
  const [rightPanelWidth, setRightPanelWidth] = useState(
    savedShell.rightPanelWidth ?? DEFAULT_RIGHT_WIDTH,
  );

  // Detect preset via ResizeObserver on the outer workspace container.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => {
      const w = entry.contentRect.width;
      if (w === 0) return;
      const next: LayoutPreset = w < 900 ? 'compact' : w < 1800 ? 'standard' : 'wide';
      if (next !== presetRef.current) {
        presetRef.current = next;
        setPreset(next);

        const saved = loadPanes();
        const initial: Pane[] =
          next === 'compact'
            ? defaultPanes('compact')
            : (saved[next] ?? panesRef.current);
        panesRef.current = initial;
        setPanes(initial);
      }
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Keep panesRef in sync.
  useEffect(() => { panesRef.current = panes; }, [panes]);

  // Persist panes on every change (non-compact only).
  useEffect(() => {
    if (presetRef.current !== 'compact') {
      savePanes(presetRef.current, panes);
    }
  }, [panes]);

  // Persist shell state.
  useEffect(() => {
    saveShell({ leftSidebarWidth, rightTool, rightPanelWidth });
  }, [leftSidebarWidth, rightTool, rightPanelWidth]);

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  const update = useCallback((fn: (prev: Pane[]) => Pane[]) => {
    setPanes((prev) => {
      const next = fn(prev);
      panesRef.current = next;
      return next;
    });
  }, []);

  function countLogviewers(ps: Pane[]): number {
    return ps.reduce((n, p) => n + p.tabs.filter((t) => t.type === 'logviewer').length, 0);
  }

  function redistribute(ps: Pane[], removedFlex: number, removedIdx: number): Pane[] {
    if (ps.length === 0) return ps;
    const targetIdx = removedIdx > 0 ? removedIdx - 1 : 0;
    return ps.map((p, i) =>
      i === targetIdx ? { ...p, flexBasis: p.flexBasis + removedFlex } : p,
    );
  }

  // ---------------------------------------------------------------------------
  // Center pane operations
  // ---------------------------------------------------------------------------

  const moveTab = useCallback((tabId: string, fromPaneId: string, toPaneId: string) => {
    if (fromPaneId === toPaneId) return;
    update((prev) => {
      const tab = prev.flatMap((p) => p.tabs).find((t) => t.id === tabId);
      if (!tab) return prev;
      const fromPane = prev.find((p) => p.id === fromPaneId);
      if (!fromPane) return prev;
      if (tab.type === 'logviewer' && countLogviewers(prev) <= 1) return prev;

      let next = prev.map((p) => {
        if (p.id === fromPaneId) {
          const tabs = p.tabs.filter((t) => t.id !== tabId);
          const activeTabId =
            p.activeTabId === tabId ? (tabs[0]?.id ?? '') : p.activeTabId;
          return { ...p, tabs, activeTabId };
        }
        if (p.id === toPaneId) {
          return { ...p, tabs: [...p.tabs, tab], activeTabId: tab.id };
        }
        return p;
      });

      const removedPanes = next.filter((p) => p.tabs.length === 0);
      for (const rp of removedPanes) {
        const idx = next.findIndex((p) => p.id === rp.id);
        next = redistribute(
          next.filter((p) => p.id !== rp.id),
          rp.flexBasis,
          idx,
        );
      }

      return next;
    });
  }, [update]);

  const splitRight = useCallback((tabId: string, fromPaneId: string) => {
    update((prev) => {
      const fromIdx = prev.findIndex((p) => p.id === fromPaneId);
      if (fromIdx === -1) return prev;
      const fromPane = prev[fromIdx];
      const tab = fromPane.tabs.find((t) => t.id === tabId);
      if (!tab) return prev;

      if (tab.type === 'logviewer' && countLogviewers(prev) <= 1) {
        // Create a new logviewer tab in the new pane (allow multiple views).
        const newTab = makeTab('logviewer');
        const half = fromPane.flexBasis / 2;
        const updatedFrom = { ...fromPane, flexBasis: half };
        const newPane = makePane([], half);
        const newPaneWithTab: Pane = { ...newPane, tabs: [newTab], activeTabId: newTab.id };
        const result = [...prev];
        result[fromIdx] = updatedFrom;
        result.splice(fromIdx + 1, 0, newPaneWithTab);
        return result;
      }

      const half = fromPane.flexBasis / 2;
      const updatedTabs = fromPane.tabs.filter((t) => t.id !== tabId);
      const updatedFrom: Pane = {
        ...fromPane,
        flexBasis: half,
        tabs: updatedTabs,
        activeTabId:
          fromPane.activeTabId === tabId ? (updatedTabs[0]?.id ?? '') : fromPane.activeTabId,
      };
      const newPane: Pane = {
        id: crypto.randomUUID(),
        tabs: [tab],
        activeTabId: tab.id,
        flexBasis: half,
      };
      const result = [...prev];
      result[fromIdx] = updatedFrom;
      result.splice(fromIdx + 1, 0, newPane);
      return result;
    });
  }, [update]);

  const closeTab = useCallback((tabId: string, paneId: string) => {
    update((prev) => {
      const pane = prev.find((p) => p.id === paneId);
      if (!pane) return prev;
      const tab = pane.tabs.find((t) => t.id === tabId);
      if (!tab) return prev;
      if (tab.type === 'logviewer' && countLogviewers(prev) <= 1) return prev;

      const tabs = pane.tabs.filter((t) => t.id !== tabId);
      let next: Pane[];

      if (tabs.length === 0) {
        const idx = prev.findIndex((p) => p.id === paneId);
        next = redistribute(
          prev.filter((p) => p.id !== paneId),
          pane.flexBasis,
          idx,
        );
      } else {
        const activeTabId =
          pane.activeTabId === tabId ? (tabs[0]?.id ?? '') : pane.activeTabId;
        next = prev.map((p) => (p.id === paneId ? { ...p, tabs, activeTabId } : p));
      }

      return next;
    });
  }, [update]);

  const setActiveTab = useCallback((tabId: string, paneId: string) => {
    update((prev) =>
      prev.map((p) => (p.id === paneId ? { ...p, activeTabId: tabId } : p)),
    );
  }, [update]);

  const addTab = useCallback((paneId: string, type: TabType) => {
    update((prev) =>
      prev.map((p) => {
        if (p.id !== paneId) return p;
        const tab = makeTab(type);
        return { ...p, tabs: [...p.tabs, tab], activeTabId: tab.id };
      }),
    );
  }, [update]);

  const resizePane = useCallback((paneId: string, deltaFraction: number) => {
    update((prev) => {
      const idx = prev.findIndex((p) => p.id === paneId);
      if (idx === -1 || idx >= prev.length - 1) return prev;
      const a = prev[idx];
      const b = prev[idx + 1];
      const newA = Math.max(MIN_FLEX, Math.min(1 - MIN_FLEX, a.flexBasis + deltaFraction));
      const diff = newA - a.flexBasis;
      const newB = Math.max(MIN_FLEX, b.flexBasis - diff);
      return prev.map((p, i) => {
        if (i === idx) return { ...p, flexBasis: newA };
        if (i === idx + 1) return { ...p, flexBasis: newB };
        return p;
      });
    });
  }, [update]);

  // ---------------------------------------------------------------------------
  // Shell operations
  // ---------------------------------------------------------------------------

  const toggleRightTool = useCallback((tool: RightTool) => {
    setRightTool((prev) => (prev === tool ? null : tool));
  }, []);

  const resizeLeftSidebar = useCallback((delta: number) => {
    setLeftSidebarWidth((prev) =>
      Math.max(MIN_LEFT_WIDTH, Math.min(MAX_LEFT_WIDTH, prev + delta)),
    );
  }, []);

  // Right panel: drag handle is at its LEFT edge.
  // Dragging LEFT (negative delta) → panel grows wider.
  const resizeRightPanel = useCallback((delta: number) => {
    setRightPanelWidth((prev) =>
      Math.max(MIN_RIGHT_WIDTH, Math.min(MAX_RIGHT_WIDTH, prev - delta)),
    );
  }, []);

  const openCenterTab = useCallback((type: TabType) => {
    update((prev) => {
      // 1. Already exists somewhere → just activate it.
      for (const pane of prev) {
        const existing = pane.tabs.find((t) => t.type === type);
        if (existing) {
          return prev.map((p) =>
            p.id === pane.id ? { ...p, activeTabId: existing.id } : p,
          );
        }
      }

      // 2. Only one pane → split right so the new tab opens alongside the log viewer.
      if (prev.length === 1) {
        const fromPane = prev[0];
        const half = fromPane.flexBasis / 2;
        const newTab = makeTab(type);
        const updatedFrom = { ...fromPane, flexBasis: half };
        const newPane: Pane = {
          id: crypto.randomUUID(),
          tabs: [newTab],
          activeTabId: newTab.id,
          flexBasis: half,
        };
        return [updatedFrom, newPane];
      }

      // 3. Multiple panes → add to the last (rightmost) pane.
      const lastPane = prev[prev.length - 1];
      const newTab = makeTab(type);
      return prev.map((p) =>
        p.id === lastPane.id
          ? { ...p, tabs: [...p.tabs, newTab], activeTabId: newTab.id }
          : p,
      );
    });
  }, [update]);

  const resetLayout = useCallback(() => {
    localStorage.removeItem(PANES_KEY);
    localStorage.removeItem(SHELL_KEY);
    window.location.reload();
  }, []);

  return {
    panes,
    preset,
    containerRef,
    centerRef,
    moveTab,
    splitRight,
    closeTab,
    setActiveTab,
    addTab,
    resizePane,
    leftSidebarWidth,
    rightTool,
    rightPanelWidth,
    toggleRightTool,
    resizeLeftSidebar,
    resizeRightPanel,
    openCenterTab,
    resetLayout,
  };
}
