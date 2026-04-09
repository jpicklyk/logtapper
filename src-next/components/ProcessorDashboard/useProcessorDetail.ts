import { useState, useEffect, useCallback, useRef } from 'react';
import type { MatchedLine, StateTransition, StateSnapshot, CorrelatorResult } from '../../bridge/types';
import { getMatchedLines, getPiiMappings, getStateTransitions, getStateAtLine, getCorrelatorEvents } from '../../bridge/commands';
import { usePipeline } from '../../hooks';

export interface UseProcessorDetailParams {
  selectedId: string | null;
  sessionId: string | null;
  runCount: number;
  processorType: string | null; // 'reporter' | 'state_tracker' | 'correlator' | null
}

export interface UseProcessorDetailResult {
  vars: Record<string, unknown> | null;
  piiMappings: Record<string, string>;
  trackerTransitions: StateTransition[];
  trackerSnapshot: StateSnapshot | null;
  correlatorResult: CorrelatorResult | null;
  matchedLines: MatchedLine[];
  matchesLoading: boolean;
  showMatches: boolean;
  matchSearch: string;
  handleToggleMatches: () => void;
  setMatchSearch: (value: string) => void;
  fetchMatches: (showLoading?: boolean) => Promise<void>;
}

export function useProcessorDetail({
  selectedId,
  sessionId,
  runCount,
  processorType,
}: UseProcessorDetailParams): UseProcessorDetailResult {
  const pipeline = usePipeline();

  const [vars, setVars] = useState<Record<string, unknown> | null>(null);
  const [piiMappings, setPiiMappings] = useState<Record<string, string>>({});
  const [showMatches, setShowMatches] = useState(false);
  const [matchedLines, setMatchedLines] = useState<MatchedLine[]>([]);
  const [matchesLoading, setMatchesLoading] = useState(false);
  const [matchSearch, setMatchSearch] = useState('');
  const [trackerTransitions, setTrackerTransitions] = useState<StateTransition[]>([]);
  const [trackerSnapshot, setTrackerSnapshot] = useState<StateSnapshot | null>(null);
  const [correlatorResult, setCorrelatorResult] = useState<CorrelatorResult | null>(null);

  // Without a ref, the streaming effect closes over the initial showMatches=false
  // and never sees it become true (its dep array is [runCount] only).
  const showMatchesRef = useRef(false);
  showMatchesRef.current = showMatches;

  // Sequence counter to prevent stale fetchMatches overwrites
  const fetchSeqRef = useRef(0);

  // Reset match state when the selected processor changes.
  // Also bump fetchSeqRef so any in-flight fetchMatches from the previous
  // processor is treated as stale and discarded when it resolves.
  useEffect(() => {
    fetchSeqRef.current++;
    setShowMatches(false);
    setMatchedLines([]);
    setMatchSearch('');
    setPiiMappings({});
  }, [selectedId]);

  // Fetch vars
  useEffect(() => {
    if (!selectedId || !sessionId || runCount === 0) {
      setVars(null);
      return;
    }
    let cancelled = false;
    pipeline
      .getVars(sessionId, selectedId)
      .then((v) => { if (!cancelled) setVars(v); })
      .catch(() => { if (!cancelled) setVars(null); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId, sessionId, runCount]);

  // PII mappings
  useEffect(() => {
    if (selectedId === '__pii_anonymizer' && sessionId && runCount > 0) {
      let cancelled = false;
      getPiiMappings(sessionId)
        .then((m) => { if (!cancelled) setPiiMappings(m); })
        .catch(() => { if (!cancelled) setPiiMappings({}); });
      return () => { cancelled = true; };
    }
  }, [selectedId, sessionId, runCount]);

  // Fetch state tracker transitions + final snapshot
  useEffect(() => {
    if (!selectedId || !sessionId || runCount === 0 || processorType !== 'state_tracker') {
      setTrackerTransitions([]);
      setTrackerSnapshot(null);
      return;
    }
    let cancelled = false;
    Promise.all([
      getStateTransitions(sessionId, selectedId),
      getStateAtLine(sessionId, selectedId, Number.MAX_SAFE_INTEGER),
    ]).then(([transitions, snapshot]) => {
      if (cancelled) return;
      setTrackerTransitions(transitions);
      setTrackerSnapshot(snapshot);
    }).catch(() => {
      if (cancelled) return;
      setTrackerTransitions([]);
      setTrackerSnapshot(null);
    });
    return () => { cancelled = true; };
  }, [selectedId, sessionId, runCount, processorType]);

  // Fetch correlator events
  useEffect(() => {
    if (!selectedId || !sessionId || runCount === 0 || processorType !== 'correlator') {
      setCorrelatorResult(null);
      return;
    }
    let cancelled = false;
    getCorrelatorEvents(sessionId, selectedId)
      .then((result) => { if (!cancelled) setCorrelatorResult(result); })
      .catch(() => { if (!cancelled) setCorrelatorResult(null); });
    return () => { cancelled = true; };
  }, [selectedId, sessionId, runCount, processorType]);

  const fetchMatches = useCallback(async (showLoading = true) => {
    if (!selectedId || !sessionId) return;
    const seq = ++fetchSeqRef.current;
    if (showLoading) setMatchesLoading(true);
    try {
      const next = await getMatchedLines(sessionId, selectedId);
      if (fetchSeqRef.current !== seq) return; // stale — discard
      // Referential bail-out: skip update if the line count and last entry
      // are unchanged — avoids re-rendering the list (and losing scroll
      // position) during streaming when no new matches have arrived.
      setMatchedLines((prev) => {
        if (
          prev.length === next.length &&
          prev.length > 0 &&
          prev[prev.length - 1].lineNum === next[next.length - 1].lineNum
        ) return prev;
        return next;
      });
    } catch {
      if (fetchSeqRef.current !== seq) return;
      setMatchedLines([]);
    } finally {
      if (fetchSeqRef.current === seq) setMatchesLoading(false);
    }
  }, [selectedId, sessionId]);

  const handleToggleMatches = useCallback(() => {
    if (!showMatches) fetchMatches();
    setShowMatches((v) => !v);
    setMatchSearch('');
  }, [showMatches, fetchMatches]);

  // Silent refetch during streaming — no loading indicator, referential
  // bail-out prevents re-render when matches haven't changed.
  useEffect(() => {
    if (showMatchesRef.current && runCount > 0) fetchMatches(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runCount]);

  return {
    vars,
    piiMappings,
    trackerTransitions,
    trackerSnapshot,
    correlatorResult,
    matchedLines,
    matchesLoading,
    showMatches,
    matchSearch,
    handleToggleMatches,
    setMatchSearch,
    fetchMatches,
  };
}
