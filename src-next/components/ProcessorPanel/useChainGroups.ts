import { useState, useEffect, useCallback, useMemo } from 'react';
import type { ProcessorSummary, PipelineRunSummary, PipelineProgress, PackSummary } from '../../bridge/types';
import { resolveChainProcessors, groupProcessorsByPack } from '../../bridge/types';
import { PINNED_TAIL_IDS } from '../../context';

const LS_EXPANDED_PACKS_KEY = 'logtapper_pipeline_expanded_packs';

interface ChainGroupsParams {
  processors: ProcessorSummary[];
  pipelineChain: string[];
  disabledChainIds: string[];
  packs: PackSummary[];
  lastResults: PipelineRunSummary[];
  progress: { current: number; total: number } | null;
  sessionId: string | null;
  removeFromChain: (id: string) => void;
  toggleChainEnabled: (id: string) => void;
}

export function useChainGroups({
  processors,
  pipelineChain,
  disabledChainIds,
  packs,
  lastResults,
  progress,
  sessionId,
  removeFromChain,
  toggleChainEnabled,
}: ChainGroupsParams) {
  // Expanded packs state (persisted to localStorage)
  const [expandedPacks, setExpandedPacks] = useState<Set<string>>(() => {
    try {
      const raw = localStorage.getItem(LS_EXPANDED_PACKS_KEY);
      if (raw) return new Set<string>(JSON.parse(raw));
    } catch { /* ignore */ }
    // Default: all expanded
    return new Set<string>();
  });

  // After packs load, auto-expand all if expandedPacks is empty (first visit)
  const [expandedPacksInitialized, setExpandedPacksInitialized] = useState(false);
  useEffect(() => {
    if (!expandedPacksInitialized && packs.length > 0) {
      setExpandedPacksInitialized(true);
      setExpandedPacks((prev) => {
        if (prev.size > 0) return prev;
        // All packs expanded by default
        return new Set(packs.map((p) => p.id));
      });
    }
  }, [packs, expandedPacksInitialized]);

  const handleTogglePackExpand = useCallback((packId: string) => {
    setExpandedPacks((prev) => {
      const next = new Set(prev);
      if (next.has(packId)) next.delete(packId);
      else next.add(packId);
      return next;
    });
  }, []);

  // Persist expandedPacks to localStorage via effect (not inside the updater —
  // updaters are called twice in StrictMode, so side effects must live here).
  useEffect(() => {
    try { localStorage.setItem(LS_EXPANDED_PACKS_KEY, JSON.stringify([...expandedPacks])); } catch { /* ignore */ }
  }, [expandedPacks]);

  // ── Chain filter (local ephemeral state) ──
  const [chainFilter, setChainFilter] = useState('');

  const disabledSet = useMemo(() => new Set(disabledChainIds), [disabledChainIds]);

  const resultMap = useMemo(
    () =>
      new Map<string, PipelineRunSummary>(
        (lastResults as PipelineRunSummary[]).map((r) => [r.processorId, r]),
      ),
    [lastResults],
  );

  const allChainProcessors = useMemo(
    () => resolveChainProcessors(pipelineChain, processors),
    [pipelineChain, processors],
  );

  const sortableProcessors = useMemo(
    () => allChainProcessors.filter((p) => !PINNED_TAIL_IDS.has(p.id)),
    [allChainProcessors],
  );
  const pinnedProcessors = useMemo(
    () => allChainProcessors.filter((p) => PINNED_TAIL_IDS.has(p.id)),
    [allChainProcessors],
  );

  // ── Filtered pinned processors (chain filter for pinned tail nodes) ──
  const filteredPinned = useMemo(() => {
    if (!chainFilter) return pinnedProcessors;
    const q = chainFilter.toLowerCase();
    return pinnedProcessors.filter((p) => p.name.toLowerCase().includes(q));
  }, [pinnedProcessors, chainFilter]);

  // ── Pack grouping ──

  // Build pack groups from packs that have at least one processor in the sortable
  // chain. Processors within each pack are ordered by `sortableProcessors` (chain
  // order), not `pack.processorIds` (manifest order) — this list is drag-reorderable
  // (see ProcessorPanel's DndContext), so it must reflect the user's chain order.
  const { packGroups, standaloneProcessors } = useMemo(
    () => groupProcessorsByPack(sortableProcessors, packs),
    [sortableProcessors, packs],
  );

  // Stable lookup: packId → processor IDs (qualified), used by pack-level handlers.
  // Keyed by packId so handlers don't need to close over per-pack data.
  const packProcessorIdsMap = useMemo(
    () => new Map(packGroups.map((g) => [g.pack.id, g.processors.map((p) => p.id)])),
    [packGroups],
  );

  // Pack-level handlers — accept packId so they can be passed as stable useCallback
  // refs to PackGroup without creating per-pack inline arrows in the render loop.
  const handleTogglePackEnabled = useCallback(
    (packId: string) => {
      const packProcessorIds = packProcessorIdsMap.get(packId) ?? [];
      // If all are enabled, disable all; otherwise enable all
      const allEnabled = packProcessorIds.every((id) => !disabledSet.has(id));
      for (const id of packProcessorIds) {
        const isDisabled = disabledSet.has(id);
        if (allEnabled && !isDisabled) {
          toggleChainEnabled(id);
        } else if (!allEnabled && isDisabled) {
          toggleChainEnabled(id);
        }
      }
    },
    [packProcessorIdsMap, disabledSet, toggleChainEnabled],
  );

  const handleRemovePack = useCallback(
    (packId: string) => {
      const packProcessorIds = packProcessorIdsMap.get(packId) ?? [];
      for (const id of packProcessorIds) {
        removeFromChain(id);
      }
    },
    [packProcessorIdsMap, removeFromChain],
  );

  // Filtered pack groups and standalone (apply chainFilter when active)
  const { filteredPackGroups, filteredStandalone } = useMemo(() => {
    if (!chainFilter) {
      return { filteredPackGroups: packGroups, filteredStandalone: standaloneProcessors };
    }
    const q = chainFilter.toLowerCase();
    const filteredGroups = packGroups
      .map((g) => ({
        ...g,
        processors: g.processors.filter((p) => p.name.toLowerCase().includes(q)),
      }))
      .filter((g) => g.processors.length > 0);
    const filteredStandaloneArr = standaloneProcessors.filter((p) =>
      p.name.toLowerCase().includes(q),
    );
    return { filteredPackGroups: filteredGroups, filteredStandalone: filteredStandaloneArr };
  }, [packGroups, standaloneProcessors, chainFilter]);

  const filteredStandaloneIds = useMemo(
    () => filteredStandalone.map((p) => p.id),
    [filteredStandalone],
  );

  // Total filtered count for chain filter display
  const filteredTotal = useMemo(() => {
    const packCount = filteredPackGroups.reduce((sum, g) => sum + g.processors.length, 0);
    return packCount + filteredStandalone.length + filteredPinned.length;
  }, [filteredPackGroups, filteredStandalone, filteredPinned]);

  // Progress map from context
  const progressMap = useMemo(() => {
    if (!progress) return {};
    const map: Record<string, PipelineProgress> = {};
    for (const id of pipelineChain) {
      map[id] = {
        sessionId: sessionId ?? '',
        processorId: id,
        linesProcessed: progress.current,
        totalLines: progress.total,
        percent: progress.total > 0 ? (progress.current / progress.total) * 100 : 0,
      };
    }
    return map;
  }, [progress, pipelineChain, sessionId]);

  return {
    expandedPacks,
    handleTogglePackExpand,
    chainFilter,
    setChainFilter,
    disabledSet,
    resultMap,
    allChainProcessors,
    filteredPinned,
    handleTogglePackEnabled,
    handleRemovePack,
    filteredPackGroups,
    filteredStandalone,
    filteredStandaloneIds,
    filteredTotal,
    progressMap,
  };
}
