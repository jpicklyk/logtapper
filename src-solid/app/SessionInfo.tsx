/** @jsxImportSource solid-js */
import { For, Show, createMemo, createSignal, onCleanup, onMount } from 'solid-js';
import type { JSX } from 'solid-js';
import type { DumpstateMetadata, SourceType } from '@bridge/types';
import { isBugreportLike } from '@bridge/types';
import { buildReopenOptions, REOPEN_SOURCE_TYPES } from '@fileinfo/reopenOptions';
import type { ReopenOption } from '@fileinfo/reopenOptions';
import { formatDuration, formatTimestamp } from '@fileinfo/formatters';
import type { SessionEntry } from './sessions';
import styles from './sessionInfo.module.css';

/**
 * Mirrors `src-next/utils.ts`'s `formatFileSize` exactly (same thresholds,
 * same output). That file is React-only territory reached by no shared
 * alias, and adding a cross-boundary alias for one four-line pure function
 * would cost more (a new `@`-alias, an ESLint allow-list entry, an
 * `aliases.test.ts` pin) than duplicating it here costs in drift risk.
 */
function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

export interface SessionInfoProps {
  /** The focused session — the status bar only ever renders this one. */
  entry: SessionEntry;
  /**
   * Bugreport/dumpstate device fields, read from the sections store's own
   * fetch (`sections/sectionsStore.ts`'s `metadata()` accessor, populated by
   * its own `getDumpstateMetadata` call). This component fetches nothing of
   * its own — there is no second dumpstate-metadata request for the same
   * session.
   */
  metadata: DumpstateMetadata | null;
  /** Reopen the session's file with an explicit source type (a replace). */
  onReopenAs: (sourceType: SourceType) => void;
  /**
   * Controlled open state, so a second entry point (the top bar's "File info"
   * button) can drive the same popover. Pass both or neither; without them
   * the chip owns its own state.
   */
  open?: () => boolean;
  onOpenChange?: (open: boolean) => void;
}

/**
 * Status-bar session chip: a trigger button with the name/line-count text
 * the footer has always shown (`data-testid="status-session"` — pinned by
 * `App.test.tsx`'s "reports the focused session in the footer" test) that
 * opens a popover with the full file identity, stats, and — for a
 * file-backed, non-streaming, non-`.lts` session — a "reopen as…" control.
 *
 * Mirrors `src-next/components/FileInfoPanel/{FileInfoPanel,FileInfoPane}.tsx`
 * (React's left-pane "File Info" tab): same fields, same reopen semantics
 * ("REPLACE, not close-then-open" — see `SessionInfoPopover`'s doc comment),
 * surfaced as a status-bar popover instead of a permanent pane, since this
 * shell has no equivalent rail slot yet (out of this task's scope — see
 * implementation-notes).
 */
export function SessionInfo(props: SessionInfoProps): JSX.Element {
  const [localOpen, setLocalOpen] = createSignal(false);
  const open = (): boolean => (props.open ? props.open() : localOpen());
  const setOpen = (next: boolean): void => {
    if (props.onOpenChange) props.onOpenChange(next);
    else setLocalOpen(next);
  };
  let triggerRef: HTMLButtonElement | undefined;

  const load = () => props.entry.load;

  // A reopen replaces the session at its own (deterministic) id, so it isn't
  // offered for a session with no backing file, a live stream, or a `.lts`
  // bundle — each embedded `.lts` session already carries the type it was
  // captured with, and the backend rejects an override for it. Mirrors
  // `FileInfoPane.tsx`'s `canReopen`, but reads `entry.kind` — this store's
  // live-updated equivalent of React's `isStreamingSession` — rather than
  // the load-time `load.isStreaming` snapshot, which stays `true` forever
  // once a stream has stopped (see `sessions.ts`'s `setStreamingKind`).
  const canReopen = createMemo(
    () => !!load().filePath && props.entry.kind !== 'live' && !load().filePath!.toLowerCase().endsWith('.lts'),
  );

  const reopenOptions = createMemo(() => buildReopenOptions(load().sourceType));
  const duration = createMemo(() => formatDuration(load().firstTimestamp, load().lastTimestamp));
  const deviceMeta = createMemo(() => (isBugreportLike(load().sourceType) ? props.metadata : null));

  const close = (): void => { setOpen(false); };

  return (
    <span class={styles.anchor}>
      <button
        type="button"
        ref={triggerRef}
        class={styles.trigger}
        data-testid="status-session"
        aria-haspopup="dialog"
        aria-expanded={open()}
        title="Session info: lines, size, time range, device details and reopen as"
        onClick={() => { setOpen(!open()); }}
      >
        <span class={styles.glyph} aria-hidden="true">ⓘ</span>
        {load().sourceName} — {props.entry.totalLines.toLocaleString()} lines
        <Show when={props.entry.isIndexing}> (indexing…)</Show>
      </button>
      <Show when={open()}>
        <SessionInfoPopover
          entry={props.entry}
          deviceMeta={deviceMeta()}
          canReopen={canReopen()}
          reopenOptions={reopenOptions()}
          duration={duration()}
          onReopenAs={(t) => {
            props.onReopenAs(t);
            close();
          }}
          onClose={close}
          restoreFocusTo={triggerRef}
        />
      </Show>
    </span>
  );
}

interface SessionInfoPopoverProps {
  entry: SessionEntry;
  deviceMeta: DumpstateMetadata | null;
  canReopen: boolean;
  reopenOptions: ReopenOption[];
  duration: string | null;
  onReopenAs: (sourceType: SourceType) => void;
  onClose: () => void;
  restoreFocusTo: HTMLButtonElement | undefined;
}

const TITLE_ID = 'session-info-title';

/**
 * A fresh instance mounted by the `<Show>` above each time the popover
 * opens — the same pattern `bookmarks/CreateBookmarkDialog.tsx` uses — so
 * its mount/cleanup pair IS the open/close transition, not every re-render.
 *
 * Focus in/out and Escape are hand-rolled rather than imported from
 * `analyzers/overlayDialog.ts`'s `createOverlayDialog`: that helper is not
 * on the `analyzers/` barrel (deliberately private, per its own doc
 * comment) and this package may only import across a module boundary
 * through a barrel — see this task's implementation-notes for the
 * follow-up to hoist it into `reactive/` or `ui/` so a third caller (this
 * one) doesn't reimplement the same dozen lines again.
 *
 * Reopen semantics: this deliberately does NOT close the session first.
 * Closing runs the backend's close path, which deletes the session's
 * bookmarks and analyses — and re-opening the same path (a deterministic
 * id) rescues exactly those onto the "new" session. Closing here would
 * destroy them before that rescue could run. `onReopenAs` instead calls
 * `actions.openPath(path, { sourceType, replace: true })`, which reuses the
 * pane's tab and explicitly resets the session-store entry in place — see
 * `sessions.ts`'s `SessionStore.replace`.
 */
function SessionInfoPopover(props: SessionInfoPopoverProps): JSX.Element {
  let rootRef: HTMLDivElement | undefined;

  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.key !== 'Escape') return;
    event.stopPropagation();
    props.onClose();
  };

  const onDocumentPointerDown = (event: PointerEvent): void => {
    const target = event.target as Node | null;
    if (!target) return;
    if (rootRef?.contains(target)) return;
    if (props.restoreFocusTo?.contains(target)) return;
    props.onClose();
  };

  onMount(() => {
    rootRef?.focus();
    document.addEventListener('keydown', onKeyDown);
    document.addEventListener('pointerdown', onDocumentPointerDown);
  });
  onCleanup(() => {
    document.removeEventListener('keydown', onKeyDown);
    document.removeEventListener('pointerdown', onDocumentPointerDown);
    props.restoreFocusTo?.focus?.();
  });

  const load = () => props.entry.load;

  return (
    <div
      ref={rootRef}
      class={styles.popover}
      role="dialog"
      aria-modal="true"
      aria-labelledby={TITLE_ID}
      tabIndex={-1}
      data-testid="session-info-popover"
    >
      <div class={styles.header}>
        <span class={styles.fileName} id={TITLE_ID} title={load().sourceName}>
          {load().sourceName}
        </span>
        <span class={styles.typeBadge}>{load().sourceType}</span>
      </div>

      <Show when={props.canReopen}>
        <label class={styles.reopenRow}>
          <span class={styles.fieldLabel}>Reopen as</span>
          <select
            class={styles.select}
            value={load().sourceType}
            aria-label="Reopen this file as a different source type"
            title={
              "The source type is detected from the file's leading bytes and decides " +
              'both how lines are parsed and which processors are eligible to run. ' +
              'If detection got it wrong, reopen the file as the correct type.'
            }
            onChange={(e) => {
              const next = e.currentTarget.value;
              // Defensive against a programmatic change event — the browser
              // already refuses to select a disabled `<option>` (the
              // current-type placeholder `buildReopenOptions` prepends when
              // the type isn't a built-in reopen target) via the UI.
              if (next !== load().sourceType && REOPEN_SOURCE_TYPES.includes(next as SourceType)) {
                props.onReopenAs(next as SourceType);
              }
            }}
          >
            <For each={props.reopenOptions}>
              {(opt) => (
                <option value={opt.value} disabled={opt.disabled}>
                  {opt.label}
                </option>
              )}
            </For>
          </select>
        </label>
      </Show>

      <div class={styles.statsGrid}>
        <div class={styles.stat}>
          <span class={styles.fieldLabel}>Lines</span>
          <span class={styles.fieldValue}>{props.entry.totalLines.toLocaleString()}</span>
        </div>
        <div class={styles.stat}>
          <span class={styles.fieldLabel}>Size</span>
          <span class={styles.fieldValue}>{formatFileSize(load().fileSize)}</span>
        </div>
        <div class={styles.stat}>
          <span class={styles.fieldLabel}>Encoding</span>
          <span class={styles.fieldValue}>{load().encoding}</span>
        </div>
        <div class={styles.stat}>
          <span class={styles.fieldLabel}>Line endings</span>
          <span class={styles.fieldValue}>{load().hasCrlf ? 'CRLF' : 'LF'}</span>
        </div>
      </div>

      <Show when={load().firstTimestamp || load().lastTimestamp}>
        <div class={styles.timeRange}>
          <div class={styles.timeRow}>
            <span class={styles.fieldLabel}>From</span>
            <span class={styles.fieldValue}>{formatTimestamp(load().firstTimestamp)}</span>
          </div>
          <div class={styles.timeRow}>
            <span class={styles.fieldLabel}>To</span>
            <span class={styles.fieldValue}>{formatTimestamp(load().lastTimestamp)}</span>
          </div>
          <Show when={props.duration}>
            <div class={styles.timeRow}>
              <span class={styles.fieldLabel}>Duration</span>
              <span class={styles.fieldValue}>{props.duration}</span>
            </div>
          </Show>
        </div>
      </Show>

      <Show when={props.deviceMeta}>
        {(meta) => (
          <div class={styles.deviceGrid}>
            <DeviceField label="Manufacturer" value={meta().manufacturer} />
            <DeviceField label="Model" value={meta().deviceModel} />
            <DeviceField label="Android" value={meta().osVersion} />
            <DeviceField label="SDK" value={meta().sdkVersion} />
            <DeviceField label="Build" value={meta().buildType} />
            <DeviceField label="Build ID" value={meta().buildString} />
            <DeviceField label="Fingerprint" value={meta().buildFingerprint} />
            <DeviceField label="Serial" value={meta().serial} />
            <DeviceField label="Bootloader" value={meta().bootloader} />
            <DeviceField label="Kernel" value={meta().kernelVersion} />
            <DeviceField label="Uptime" value={meta().uptime} />
          </div>
        )}
      </Show>
    </div>
  );
}

function DeviceField(props: { label: string; value: string | null }): JSX.Element {
  return (
    <Show when={props.value}>
      <div class={styles.deviceField}>
        <span class={styles.fieldLabel}>{props.label}</span>
        <span class={styles.fieldValue} title={props.value ?? undefined}>
          {props.value}
        </span>
      </div>
    </Show>
  );
}
