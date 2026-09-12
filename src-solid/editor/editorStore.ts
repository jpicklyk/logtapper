/**
 * The editor-tabs store: every open scratch/file document, its dirty state,
 * and Save/Save As — the Solid counterpart of React's per-tab `EditorTab`
 * `localStorage` mirror plus `useEditorTabRestore`, but collapsed into one
 * store W1a's workspace can read from and hand pending tabs to.
 *
 * Lifetime: owns a `createRoot`, same pattern as `workspaceStore.ts` and
 * `app/sessions.ts`, so `App` builds it as a plain value and disposes it on
 * cleanup.
 *
 * Restore wiring (W1a contract): a workspace restore parks decoded
 * `LtwEditorTab`s in `workspace.pendingEditorTabs()` and never applies them
 * itself — "W9 calls `takePendingEditorTabs()` exactly once to adopt them."
 * This store does that from a `createEffect` over the *reactive* accessor (see
 * the module-level constraint: never `untrack` the active workspace or its
 * pending tabs), so it materialises both at construction (usually empty) and
 * whenever a later restore populates it.
 *
 * Persistence: `toLtwTabs()` projects the open docs back into
 * `LtwEditorTab[]` for `WorkspaceStoreDeps.getEditorTabs` — App wires that in
 * with a forward-reference closure (this store is built *after* the
 * workspace store, so the workspace's `getEditorTabs` closes over a `let`
 * that is only assigned once this store exists; see `App.tsx`). Every
 * mutation calls `workspace.markMutated()`, exactly like every other W9-scope
 * change; `markMutated` itself no-ops while a restore is in flight, so
 * materialising a restore's pending tabs cannot trigger a self-save.
 */
import { createEffect, createRoot, createSignal } from 'solid-js';
import type { Accessor } from 'solid-js';
import { save as saveDialog } from '@tauri-apps/plugin-dialog';
import { readTextFile, writeTextFile } from '@bridge/commands';
import type { LtwEditorTab } from '@bridge/types';
import { basename, SAVE_FILTERS } from './EditorTab';
import type { EditorPreviewMode } from './EditorTab';

/** One open editor document. Mirrors `LtwEditorTab`'s persisted shape plus
 *  the live/saved split a running editor needs. */
export interface EditorDoc {
  id: string;
  label: string;
  /** `null` for an unsaved scratch document. */
  filePath: string | null;
  content: string;
  /** The on-disk (or last-restored) copy; `content !== savedContent` is dirty. */
  savedContent: string;
  viewMode: EditorPreviewMode | 'preview';
  wordWrap: boolean;
}

export type CloseConfirmChoice = 'save' | 'discard' | 'cancel';
/** Asks the caller (a panel with a real dialog) what to do with a dirty
 *  document before closing it. */
export type ConfirmClose = (doc: EditorDoc) => Promise<CloseConfirmChoice>;
export type CloseOutcome = 'saved' | 'discarded' | 'cancelled';

/** The slice of W1a's `WorkspaceStore` this store reads and drives. Structural
 *  on purpose — a test can pass a literal without building the real store. */
export interface EditorWorkspacePort {
  /** The active workspace id. Read reactively (never `untrack`) so a switch
   *  can be detected and this store's docs torn down before the incoming
   *  workspace's pending tabs are materialised — see the teardown effect
   *  below. */
  activeId: Accessor<string | null>;
  pendingEditorTabs: Accessor<readonly LtwEditorTab[]>;
  takePendingEditorTabs(): LtwEditorTab[];
  markMutated(): void;
}

export interface EditorFileCommands {
  readTextFile(path: string): Promise<string>;
  writeTextFile(path: string, content: string): Promise<void>;
}

export interface EditorStoreDeps {
  workspace: EditorWorkspacePort;
  /** Injected in tests; defaults to the real `@bridge/commands` wrappers. */
  commands?: EditorFileCommands;
  /** Injected in tests; defaults to the native save dialog. Returns `null`
   *  when the user cancels. */
  chooseSavePath?: (defaultLabel: string) => Promise<string | null>;
}

export interface EditorStore {
  tabs: Accessor<readonly EditorDoc[]>;
  activeId: Accessor<string | null>;
  active: Accessor<EditorDoc | undefined>;
  setActive(id: string): void;
  isDirty(id: string): boolean;

  /** Opens `path`; focuses the existing tab instead of duplicating one already
   *  open at that path. Returns the doc id either way. */
  open(path: string): Promise<string>;
  /** Creates a blank, untitled document and focuses it. Returns its id. */
  newDoc(): string;
  /** Dirty-guards the close through `confirm` (omit it to refuse closing a
   *  dirty document — the safe default, never a silent discard). */
  close(id: string, confirm?: ConfirmClose): Promise<CloseOutcome>;

  setContent(id: string, text: string): void;
  /** No path on the document → falls through to the save dialog, same as
   *  `saveAs(id)` with no explicit path. */
  save(id: string): Promise<void>;
  /** Explicit `path` skips the dialog (what tests use); omit it to prompt. */
  saveAs(id: string, path?: string): Promise<void>;
  setViewMode(id: string, mode: EditorDoc['viewMode']): void;
  setWordWrap(id: string, wordWrap: boolean): void;

  /** Project the open docs into the `.ltw` save payload shape. */
  toLtwTabs(): LtwEditorTab[];

  dispose(): void;
}

const VIEW_MODES: readonly EditorDoc['viewMode'][] = ['editor', 'split', 'preview'];

function normalizeViewMode(mode: string): EditorDoc['viewMode'] {
  return (VIEW_MODES as readonly string[]).includes(mode) ? (mode as EditorDoc['viewMode']) : 'editor';
}

async function defaultChooseSavePath(defaultLabel: string): Promise<string | null> {
  const path = await saveDialog({ defaultPath: defaultLabel, filters: SAVE_FILTERS });
  return typeof path === 'string' ? path : null;
}

export function createEditorStore(deps: EditorStoreDeps): EditorStore {
  return createRoot((disposeRoot) => {
    const commands: EditorFileCommands = deps.commands ?? { readTextFile, writeTextFile };
    const chooseSavePath = deps.chooseSavePath ?? defaultChooseSavePath;

    const [tabs, setTabs] = createSignal<readonly EditorDoc[]>([]);
    const [activeId, setActiveId] = createSignal<string | null>(null);
    let counter = 0;
    const genId = (): string => `editor-${++counter}`;

    const findDoc = (id: string): EditorDoc | undefined => tabs().find((t) => t.id === id);
    const patch = (id: string, fields: Partial<EditorDoc>): void => {
      setTabs((prev) => prev.map((t) => (t.id === id ? { ...t, ...fields } : t)));
    };

    const notifyMutated = (): void => deps.workspace.markMutated();

    const addDoc = (doc: EditorDoc): void => {
      setTabs((prev) => [...prev, doc]);
      setActiveId(doc.id);
    };

    const removeTab = (id: string): void => {
      const list = tabs();
      const idx = list.findIndex((t) => t.id === id);
      if (idx === -1) return;
      setTabs((prev) => prev.filter((t) => t.id !== id));
      if (activeId() === id) {
        const remaining = list.filter((t) => t.id !== id);
        const next = remaining[idx] ?? remaining[idx - 1];
        setActiveId(next ? next.id : null);
      }
    };

    // ── restore (W1a contract: reactive, never `untrack`) ────────────────────

    const materialize = (ltwTabs: readonly LtwEditorTab[]): void => {
      if (ltwTabs.length === 0) return;
      const docs: EditorDoc[] = ltwTabs.map((t) => ({
        id: genId(),
        label: t.label,
        filePath: t.filePath,
        content: t.content,
        savedContent: t.content,
        viewMode: normalizeViewMode(t.viewMode),
        wordWrap: t.wordWrap,
      }));
      setTabs((prev) => [...prev, ...docs]);
      if (activeId() === null) setActiveId(docs[0].id);
      notifyMutated();
    };

    // ── workspace-switch teardown ──────────────────────────────────────────
    //
    // Editor docs are per-workspace. When the active workspace id changes —
    // an explicit open, `switchWorkspace`, or `newWorkspace` — every doc left
    // over from the outgoing workspace must be closed before the incoming
    // workspace's pending tabs (if any) are materialised below, mirroring
    // `workspaceStore.ts`'s own `closeAllSessions()` teardown-before-restore
    // for session tabs. In the real app this ordering falls out naturally:
    // `workspaceStore.ts` always updates `activeId` synchronously and only
    // populates `pendingEditorTabs` later, after an `await` on the loaded
    // `.ltw` — but this effect is declared first regardless, so the ordering
    // holds even if a test (or a future caller) updates both in one tick.
    //
    // There is no app-wide dirty-tracking/autosave path for editor docs yet
    // (out of W9's scope) — a dirty, unsaved doc still open when the
    // workspace switches is silently dropped here, the same loss a browser
    // tab close without saving would cause. `markMutated()` is deliberately
    // NOT called for this teardown: it would mark the *incoming* workspace
    // dirty purely because the outgoing one had open docs.
    let lastWorkspaceId: string | null | undefined; // undefined: not yet observed
    createEffect(() => {
      const id = deps.workspace.activeId();
      if (lastWorkspaceId !== undefined && id !== lastWorkspaceId) {
        setTabs([]);
        setActiveId(null);
      }
      lastWorkspaceId = id;
    });

    createEffect(() => {
      const pending = deps.workspace.pendingEditorTabs();
      if (pending.length === 0) return;
      materialize(deps.workspace.takePendingEditorTabs());
    });

    // ── open / new / close ────────────────────────────────────────────────────

    const open = async (path: string): Promise<string> => {
      const existing = tabs().find((t) => t.filePath === path);
      if (existing) {
        setActiveId(existing.id);
        return existing.id;
      }
      const content = await commands.readTextFile(path);
      const doc: EditorDoc = {
        id: genId(),
        label: basename(path),
        filePath: path,
        content,
        savedContent: content,
        viewMode: 'editor',
        wordWrap: false,
      };
      addDoc(doc);
      notifyMutated();
      return doc.id;
    };

    const newDoc = (): string => {
      const untitledCount = tabs().filter((t) => t.filePath === null).length + 1;
      const doc: EditorDoc = {
        id: genId(),
        label: untitledCount === 1 ? 'Untitled' : `Untitled ${untitledCount}`,
        filePath: null,
        content: '',
        savedContent: '',
        viewMode: 'editor',
        wordWrap: false,
      };
      addDoc(doc);
      notifyMutated();
      return doc.id;
    };

    const commitSave = async (id: string, path: string): Promise<void> => {
      const doc = findDoc(id);
      if (!doc) return;
      await commands.writeTextFile(path, doc.content);
      patch(id, { filePath: path, savedContent: doc.content, label: basename(path) });
      notifyMutated();
    };

    /** Resolves the destination path for a save with no explicit target: the
     *  document's own path, or the chosen Save-As path. Resolves `null` when
     *  the user cancels the native dialog — callers must treat that as
     *  "nothing to do", never as a write failure. */
    const resolveSavePath = async (doc: EditorDoc): Promise<string | null> =>
      doc.filePath ?? (await chooseSavePath(doc.label));

    const save = async (id: string): Promise<void> => {
      const doc = findDoc(id);
      if (!doc) return;
      const path = await resolveSavePath(doc);
      if (!path) return;
      await commitSave(id, path);
    };

    const saveAs = async (id: string, path?: string): Promise<void> => {
      const doc = findDoc(id);
      if (!doc) return;
      const dest = path ?? (await chooseSavePath(doc.label));
      if (!dest) return;
      await commitSave(id, dest);
    };

    const close = async (id: string, confirm?: ConfirmClose): Promise<CloseOutcome> => {
      const doc = findDoc(id);
      if (!doc) return 'cancelled';
      if (doc.content === doc.savedContent) {
        removeTab(id);
        notifyMutated();
        return 'saved';
      }
      // No confirm callback and a dirty document: refuse to close rather than
      // silently discarding — the caller must supply the dialog to go further.
      if (!confirm) return 'cancelled';
      const choice = await confirm(doc);
      if (choice === 'cancel') return 'cancelled';
      if (choice === 'discard') {
        removeTab(id);
        notifyMutated();
        return 'discarded';
      }
      // choice === 'save'. Resolve the destination ourselves (rather than
      // delegating to `save(id)`) so a cancelled Save-As dialog is
      // distinguishable from a completed write: `resolveSavePath` returning
      // `null` means the user backed out of the dialog — refuse the close,
      // keep the tab open and dirty, and discard nothing. A rejection from
      // `commitSave` (the write itself failing) propagates out of `close()`
      // for the same reason: it is never reached, so `removeTab` never runs
      // and the caller's `.catch` can surface the error (see `EditorTabs.tsx`
      // and `App.tsx`'s `closeTab`).
      const path = await resolveSavePath(doc);
      if (!path) return 'cancelled';
      await commitSave(id, path);
      removeTab(id);
      notifyMutated();
      return 'saved';
    };

    // ── content / view state ──────────────────────────────────────────────────

    const setContent = (id: string, text: string): void => {
      const doc = findDoc(id);
      if (!doc || doc.content === text) return;
      patch(id, { content: text });
      notifyMutated();
    };

    const setViewMode = (id: string, mode: EditorDoc['viewMode']): void => {
      if (!findDoc(id)) return;
      patch(id, { viewMode: mode });
      notifyMutated();
    };

    const setWordWrap = (id: string, wordWrap: boolean): void => {
      if (!findDoc(id)) return;
      patch(id, { wordWrap });
      notifyMutated();
    };

    return {
      tabs,
      activeId,
      active: () => {
        const id = activeId();
        return id ? findDoc(id) : undefined;
      },
      setActive: (id: string): void => {
        if (findDoc(id)) setActiveId(id);
      },
      isDirty: (id: string): boolean => {
        const doc = findDoc(id);
        return !!doc && doc.content !== doc.savedContent;
      },
      open,
      newDoc,
      close,
      setContent,
      save,
      saveAs,
      setViewMode,
      setWordWrap,
      toLtwTabs: (): LtwEditorTab[] =>
        tabs().map((t) => ({
          label: t.label,
          content: t.content,
          viewMode: t.viewMode,
          wordWrap: t.wordWrap,
          filePath: t.filePath,
        })),
      dispose: () => disposeRoot(),
    };
  });
}
