/**
 * Analyses store (W6): the workspace-owned analysis artifact list, a per-id
 * cache for the reader, publish/update/delete, and `analysis-update` wiring.
 *
 * Lifetime: owns a `createRoot` (same pattern as `app/sessions.ts`,
 * `sections/sectionsStore.ts`, `viewer/controller.ts`). `dispose()` unlistens
 * the update subscription (including a `listen()` promise that settles after
 * disposal) and tears the root down.
 *
 * ## Deviations from the literal task-scope surface
 *
 * The design note names a minimal surface (`list`, `open`, `publish(draft)`,
 * `update(artifact)`, `remove(id)`, `selected()`, `select(id)`, `dispose`).
 * Three things needed for `AnalysesPanel`/`AnalysisReader`/`AnalysisEditor`
 * are not literally on that list and are added here rather than duplicated in
 * every consumer:
 *  - `labels` — the session-id → display-name map `analysisAttribution.ts`
 *    needs, built once here from the shared `SessionStore` rather than by
 *    each component.
 *  - `jumpTo` — the exact `controller.scrollToLine(...)` call the design
 *    section spells out for a clicked line reference, thin enough that
 *    inlining it in three components would just be copy-paste.
 *  - `cursorReference` / `captureDraftSeed` / `takeDraftSeed` — see the
 *    "Draft seed" section below.
 *
 * There is no `createdBy`/`Caller` field anywhere on `AnalysisArtifact` (the
 * generated type has `id, title, createdAt, sections, sessionId?` — the last
 * one is a read-compat leftover for old artifact-level payloads, not an
 * author). `analysisAttribution.ts` itself is about which *sessions* an
 * artifact's line references resolve against, not who published it — so the
 * "attribution" this store and `AnalysesPanel` surface is exactly that
 * (session source chips), and no `CallerBadge` is rendered for an analysis:
 * there is nothing in the wire type for it to read.
 *
 * ## Draft seed vs. selecting an artifact
 *
 * `AnalysesPanel`, `AnalysisReader` and `AnalysisEditor` are all children of
 * one store built once in `App.tsx`; selecting an artifact is a plain reactive
 * read (`selected()`), with no cross-mount race for that path.
 *
 * The genuine race is the one the design text's parenthetical describes — "a
 * line range selected in the viewer ... becomes the draft's first reference":
 * the "New analysis" button lives in `AnalysesPanel` and reads the *current*
 * controller cursor at click time, but `AnalysisEditor` (in the shell's
 * `details` region) mounts fresh afterwards. `captureDraftSeed` stashes the
 * `SourceReference` in this package's own `draftSeed.ts`; `takeDraftSeed`
 * reads and clears it exactly once, from `AnalysisEditor`'s construction.
 */
import { createMemo, createRoot, createSignal, untrack } from 'solid-js';
import type { Accessor } from 'solid-js';
import type { UnlistenFn } from '@tauri-apps/api/event';
import {
  listAnalyses as listAnalysesCmd,
  getAnalysis as getAnalysisCmd,
  publishAnalysis as publishAnalysisCmd,
  updateAnalysis as updateAnalysisCmd,
  deleteAnalysis as deleteAnalysisCmd,
} from '@bridge/commands';
import { onAnalysisUpdate } from '@bridge/events';
import type { AnalysisArtifact, AnalysisSection, AnalysisUpdateEvent, SourceReference } from '@bridge/types';
import { setDraftSeed, takeDraftSeed as takeStashedDraftSeed } from './draftSeed';
import type { LineRefTarget } from '../editor';
import type { ViewerController } from '../viewer';
// `'../app'` also matches `App.tsx` on a case-insensitive filesystem and TS
// refuses the program (TS1149) — always import the barrel via `/index`.
import type { SessionStore } from '../app/index';
import { coalesceMicrotask } from '../reactive';

export interface AnalysesCommands {
  listAnalyses: typeof listAnalysesCmd;
  getAnalysis: typeof getAnalysisCmd;
  publishAnalysis: typeof publishAnalysisCmd;
  updateAnalysis: typeof updateAnalysisCmd;
  deleteAnalysis: typeof deleteAnalysisCmd;
}

const DEFAULT_COMMANDS: AnalysesCommands = {
  listAnalyses: listAnalysesCmd,
  getAnalysis: getAnalysisCmd,
  publishAnalysis: publishAnalysisCmd,
  updateAnalysis: updateAnalysisCmd,
  deleteAnalysis: deleteAnalysisCmd,
};

export interface AnalysesStoreDeps {
  sessions: SessionStore;
  controller: ViewerController;
  /** Injected for tests; defaults to the real `onAnalysisUpdate`. */
  listen?: typeof onAnalysisUpdate;
  /** Injected for tests; defaults to the real bridge commands. */
  commands?: Partial<AnalysesCommands>;
}

export interface PublishDraft {
  title: string;
  sections: AnalysisSection[];
  sessionId?: string | null;
}

export interface UpdateDraft {
  artifactId: string;
  title?: string;
  sections?: AnalysisSection[];
}

export interface AnalysesStore {
  list: Accessor<AnalysisArtifact[]>;
  loading: Accessor<boolean>;
  /** The last `listAnalyses` / `getAnalysis` / `deleteAnalysis` failure, or
   *  `null`. Cleared by a successful refresh and by {@link AnalysesStore.retry}. */
  error: Accessor<string | null>;
  /** Clear the error and re-run `listAnalyses`. */
  retry(): void;
  /** sessionId → display label, for `analysisAttribution.ts` and the reader's references. */
  labels: Accessor<ReadonlyMap<string, string>>;

  selectedId: Accessor<string | null>;
  /** The selected artifact, from cache once fetched, else its list entry. */
  selected: Accessor<AnalysisArtifact | undefined>;
  select(id: string | null): void;
  /** Cached fetch of one artifact; the cache entry is invalidated by a
   *  matching `analysis-update` for that id. */
  open(artifactId: string): Promise<AnalysisArtifact>;

  publish(draft: PublishDraft): Promise<AnalysisArtifact>;
  update(draft: UpdateDraft): Promise<AnalysisArtifact>;
  remove(artifactId: string): Promise<void>;

  /** A `SourceReference` built from the controller's current cursor, or `null`
   *  when nothing is focused. Read live — for "add reference" while the
   *  editor is already open. */
  cursorReference(): SourceReference | null;
  /** Stash the current cursor for a not-yet-mounted `AnalysisEditor` to seed
   *  a fresh draft's first reference. Call before switching to edit mode. */
  captureDraftSeed(): void;
  /** Consume the stashed seed, once. `null` if none was captured. */
  takeDraftSeed(): SourceReference | null;

  /** Route a clicked line reference through the controller, per the W6 design:
   *  `scrollToLine(sessionId ?? focusedId, line, {highlight, select, source:'analysis'})`. */
  jumpTo(target: LineRefTarget): void;

  dispose(): void;
}

export function createAnalysesStore(deps: AnalysesStoreDeps): AnalysesStore {
  const commands: AnalysesCommands = { ...DEFAULT_COMMANDS, ...deps.commands };
  const listenFn = deps.listen ?? onAnalysisUpdate;
  const { sessions, controller } = deps;

  return createRoot((disposeRoot) => {
    const [list, setList] = createSignal<AnalysisArtifact[]>([]);
    const [loading, setLoading] = createSignal(false);
    const [error, setError] = createSignal<string | null>(null);
    const [selectedId, setSelectedId] = createSignal<string | null>(null);
    // Bumped on every cache write so `selected` (a memo) re-runs; the cache
    // itself is a plain Map — reading it from a memo would otherwise be
    // exactly the "external mutable state in a memo" trap the root CLAUDE.md
    // warns about.
    const [cacheVersion, setCacheVersion] = createSignal(0);
    const cache = new Map<string, AnalysisArtifact>();

    let disposed = false;
    let unlisten: UnlistenFn | null = null;
    let seenThisBatch = new Set<string>();

    const labels = createMemo<ReadonlyMap<string, string>>(() => {
      const map = new Map<string, string>();
      for (const id of sessions.order()) {
        map.set(id, sessions.byId(id)?.load.sourceName ?? id);
      }
      return map;
    });

    const refreshList = (): void => {
      setLoading(true);
      commands
        .listAnalyses()
        .then((artifacts) => {
          if (disposed) return;
          setList(artifacts);
          // Without this the first failure stuck on screen forever, even once
          // the very next refresh succeeded.
          setError(null);
        })
        .catch((e: unknown) => {
          if (!disposed) setError(String(e));
        })
        .finally(() => {
          if (!disposed) setLoading(false);
        });
    };

    /** Coalesces a burst of `analysis-update` events in the same microtask
     *  into one `listAnalyses()` call, and resets the per-batch dedupe set. */
    const scheduleListRefresh = coalesceMicrotask(() => {
      seenThisBatch = new Set();
      if (!disposed) refreshList();
    });

    const open = (artifactId: string): Promise<AnalysisArtifact> => {
      const cached = cache.get(artifactId);
      if (cached) return Promise.resolve(cached);
      return commands.getAnalysis(artifactId).then((artifact) => {
        if (!disposed) {
          cache.set(artifactId, artifact);
          setCacheVersion((v) => v + 1);
        }
        return artifact;
      });
    };

    const select = (id: string | null): void => {
      setSelectedId(id);
      if (id !== null) void open(id).catch((e: unknown) => setError(String(e)));
    };

    const selected = createMemo<AnalysisArtifact | undefined>(() => {
      cacheVersion();
      const id = selectedId();
      if (id === null) return undefined;
      return cache.get(id) ?? list().find((a) => a.id === id);
    });

    refreshList();

    listenFn((payload: AnalysisUpdateEvent) => {
      if (disposed) return;
      // Dedupe by artifactId+action within the current microtask batch — a
      // duplicate delivery of the same event does one unit of work, not two.
      const key = `${payload.artifactId}:${payload.action}`;
      if (!seenThisBatch.has(key)) {
        seenThisBatch.add(key);
        if (payload.action === 'deleted') {
          cache.delete(payload.artifactId);
          setCacheVersion((v) => v + 1);
          setList((prev) => prev.filter((a) => a.id !== payload.artifactId));
          if (selectedId() === payload.artifactId) setSelectedId(null);
        } else {
          // 'published' | 'updated' | 'restored' — invalidate; re-fetch only
          // if it's the one currently open.
          cache.delete(payload.artifactId);
          setCacheVersion((v) => v + 1);
          if (selectedId() === payload.artifactId) {
            void open(payload.artifactId).catch(() => undefined);
          }
        }
      }
      scheduleListRefresh();
    }).then((fn) => {
      if (disposed) fn();
      else unlisten = fn;
    });

    const publish = (draft: PublishDraft): Promise<AnalysisArtifact> =>
      commands.publishAnalysis(draft.title, draft.sections, draft.sessionId ?? null).then((artifact) => {
        if (!disposed) {
          cache.set(artifact.id, artifact);
          setCacheVersion((v) => v + 1);
          setList((prev) => [...prev, artifact]);
          select(artifact.id);
        }
        return artifact;
      });

    const update = (draft: UpdateDraft): Promise<AnalysisArtifact> =>
      commands.updateAnalysis(draft.artifactId, draft.title, draft.sections).then((artifact) => {
        if (!disposed) {
          cache.set(artifact.id, artifact);
          setCacheVersion((v) => v + 1);
          setList((prev) => prev.map((a) => (a.id === artifact.id ? artifact : a)));
        }
        return artifact;
      });

    const retry = (): void => {
      setError(null);
      refreshList();
    };

    const remove = (artifactId: string): Promise<void> =>
      commands.deleteAnalysis(artifactId).then(() => {
        if (!disposed) {
          cache.delete(artifactId);
          setCacheVersion((v) => v + 1);
          setList((prev) => prev.filter((a) => a.id !== artifactId));
          // Untracked: this runs outside any Solid computation (a promise
          // callback), so the read is a one-time check, not a subscription.
          if (untrack(selectedId) === artifactId) setSelectedId(null);
        }
      });

    const cursorReference = (): SourceReference | null => {
      const cursor = controller.cursor();
      if (!cursor) return null;
      return {
        lineNumber: cursor.line,
        endLine: null,
        label: `Line ${cursor.line}`,
        highlightType: 'Anchor',
        sessionId: cursor.sessionId,
      };
    };

    const captureDraftSeed = (): void => {
      const ref = cursorReference();
      if (!ref) return;
      setDraftSeed(ref);
    };

    const takeDraftSeed = (): SourceReference | null => takeStashedDraftSeed();

    const jumpTo = (target: LineRefTarget): void => {
      const sessionId = target.sessionId ?? sessions.focusedId();
      if (!sessionId) return;
      controller.scrollToLine(sessionId, target.line, {
        highlight: true,
        select: target.endLine != null ? [target.line, target.endLine] : undefined,
        source: 'analysis',
      });
    };

    const dispose = (): void => {
      if (disposed) return;
      disposed = true;
      unlisten?.();
      cache.clear();
      disposeRoot();
    };

    return {
      list,
      loading,
      error,
      retry,
      labels,
      selectedId,
      selected,
      select,
      open,
      publish,
      update,
      remove,
      cursorReference,
      captureDraftSeed,
      takeDraftSeed,
      jumpTo,
      dispose,
    };
  });
}
