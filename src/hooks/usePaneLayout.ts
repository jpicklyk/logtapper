import { useCallback, useEffect, useRef, useState } from 'react';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type TabType =
  | 'logviewer'
  | 'processors'
  | 'dashboard'
  | 'chat'
  | 'marketplace'
  | 'fileinfo';

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
  flexBasis: number; // 0..1 fraction of container width
}

export interface PaneLayoutState {
  panes: Pane[];
  preset: LayoutPreset;
  containerRef: React.RefObject<HTMLDivElement>;
  moveTab: (tabId: string, fromPaneId: string, toPaneId: string) => void;
  splitRight: (tabId: string, fromPaneId: string) => void;
  closeTab: (tabId: string, paneId: string) => void;
  setActiveTab: (tabId: string, paneId: string) => void;
  addTab: (paneId: string, type: TabType) => void;
  resizePane: (paneId: string, deltaFraction: number) => void;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const STORAGE_KEY = 'logtapper_panes_v1';
const MIN_FLEX = 0.10;

export const TAB_LABELS: Record<TabType, string> = {
  logviewer: 'Log',
  processors: 'Processors',
  dashboard: 'Dashboard',
  chat: 'Chat',
  marketplace: 'Market',
  fileinfo: 'File Info',
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

function defaultPanes(preset: LayoutPreset): Pane[] {
  switch (preset) {
    case 'compact':
      return [makePane(['logviewer', 'processors', 'dashboard', 'chat', 'marketplace'], 1.0)];
    case 'standard':
      return [
        makePane(['logviewer'], 0.6),
        makePane(['processors', 'dashboard', 'chat', 'marketplace'], 0.4),
      ];
    case 'wide':
      return [
        makePane(['fileinfo'], 0.15),
        makePane(['logviewer'], 0.50),
        makePane(['processors', 'dashboard', 'chat', 'marketplace'], 0.35),
      ];
  }
}

// ---------------------------------------------------------------------------
// localStorage persistence
// ---------------------------------------------------------------------------

interface PersistedLayout {
  standard?: Pane[];
  wide?: Pane[];
}

function loadLayout(): PersistedLayout {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    return JSON.parse(raw) as PersistedLayout;
  } catch {
    return {};
  }
}

function saveLayout(preset: LayoutPreset, panes: Pane[]): void {
  if (preset === 'compact') return; // compact is not persisted
  try {
    const current = loadLayout();
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...current, [preset]: panes }));
  } catch {
    // storage full or unavailable — silently ignore
  }
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export function usePaneLayout(): PaneLayoutState {
  const containerRef = useRef<HTMLDivElement>(null);
  const [preset, setPreset] = useState<LayoutPreset>('standard');
  const presetRef = useRef<LayoutPreset>('standard');

  // Initialize panes from localStorage or defaults.
  const [panes, setPanes] = useState<Pane[]>(() => {
    const saved = loadLayout();
    return saved.standard ?? defaultPanes('standard');
  });
  const panesRef = useRef<Pane[]>(panes);

  // Detect preset via ResizeObserver.
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

        // Load saved layout for this preset, or use defaults.
        const saved = loadLayout();
        const initial: Pane[] =
          next === 'compact'
            ? defaultPanes('compact')
            : (saved[next] ?? defaultPanes(next));
        panesRef.current = initial;
        setPanes(initial);
      }
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Keep panesRef in sync.
  useEffect(() => {
    panesRef.current = panes;
  }, [panes]);

  // Persist on every pane change (non-compact only).
  useEffect(() => {
    if (presetRef.current !== 'compact') {
      saveLayout(presetRef.current, panes);
    }
  }, [panes]);

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

  // Check if there's only one logviewer tab left across all panes.
  function countLogviewers(ps: Pane[]): number {
    return ps.reduce((n, p) => n + p.tabs.filter((t) => t.type === 'logviewer').length, 0);
  }

  // Redistribute flex after removing a pane — give its space to the left neighbour
  // (or right if it's the first pane).
  function redistribute(ps: Pane[], removedFlex: number, removedIdx: number): Pane[] {
    if (ps.length === 0) return ps;
    const targetIdx = removedIdx > 0 ? removedIdx - 1 : 0;
    return ps.map((p, i) =>
      i === targetIdx ? { ...p, flexBasis: p.flexBasis + removedFlex } : p,
    );
  }

  // ---------------------------------------------------------------------------
  // Operations
  // ---------------------------------------------------------------------------

  const moveTab = useCallback((tabId: string, fromPaneId: string, toPaneId: string) => {
    if (fromPaneId === toPaneId) return;
    update((prev) => {
      const tab = prev.flatMap((p) => p.tabs).find((t) => t.id === tabId);
      if (!tab) return prev;

      // Prevent removing last logviewer if it's the only one.
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

      // Auto-close panes with no tabs.
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

      // Don't split if only one logviewer exists and it's the one being split.
      if (tab.type === 'logviewer' && countLogviewers(prev) <= 1) {
        // Create a new logviewer tab for the new pane (allow multiple views).
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

      // Move the tab to a new pane to the right.
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
      // Protect last logviewer.
      if (tab.type === 'logviewer' && countLogviewers(prev) <= 1) return prev;

      const tabs = pane.tabs.filter((t) => t.id !== tabId);
      let next: Pane[];

      if (tabs.length === 0) {
        // Auto-close pane.
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

  return {
    panes,
    preset,
    containerRef,
    moveTab,
    splitRight,
    closeTab,
    setActiveTab,
    addTab,
    resizePane,
  };
}
