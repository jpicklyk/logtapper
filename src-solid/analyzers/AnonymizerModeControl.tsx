/** @jsxImportSource solid-js */
import { For, Show, createSignal } from 'solid-js';
import type { JSX } from 'solid-js';
import type { AnonymizerMode } from '@bridge/types';
import styles from './analyzers.module.css';

/** Display order of the three modes — also the arrow-key order. */
export const ANONYMIZER_MODE_OPTIONS: readonly AnonymizerMode[] = ['all', 'external', 'none'];

const MODE_LABEL: Record<AnonymizerMode, string> = {
  all: 'All',
  external: 'External',
  none: 'None',
};

/** One line per mode, phrased from the user's side: what stays raw and what
 *  does not. Shared with Settings → PII's read-only mirror so the two never
 *  drift. `None`'s line is the one rendered in the warning colour. */
const MODE_DESCRIPTION: Record<AnonymizerMode, string> = {
  all: 'viewer, agents and exports are anonymized',
  external: 'agents and exports are anonymized; the viewer shows raw text',
  none: 'raw text everywhere — agents included',
};

export function anonymizerModeLabel(mode: AnonymizerMode): string {
  return MODE_LABEL[mode];
}

export function anonymizerModeDescription(mode: AnonymizerMode): string {
  return MODE_DESCRIPTION[mode];
}

/** The presence panel's raw-access warning, reused inline on the card under
 *  `None` while the bridge is running — the same words in both places, so
 *  the card does not invent a second way of saying it. */
export const AGENTS_READ_RAW_WARNING =
  'Agents read un-anonymized log text — emails, IPs, IMEIs and serials are not tokenized.';

export interface AnonymizerModeControlProps {
  mode: AnonymizerMode;
  /** The settings store's `setAnonymizerMode`; a rejection is rendered here. */
  onChange: (mode: AnonymizerMode) => Promise<void>;
  /** `McpStatus.running` — gates the inline agents-read-raw warning. */
  bridgeRunning: boolean;
  /** An agent is actually talking to the bridge right now (presence's orb is
   *  not `detached`); switching to `None` then asks for a confirm first. */
  agentConnected: boolean;
  /** The config has not loaded yet — nothing to write the mode into. */
  disabled?: boolean;
}

/**
 * The PII Anonymizer card's body: a three-way segmented control All | External
 * | None over the one global `AnonymizerConfig.mode`, the "Applies to every
 * session" caption that says so (the card is per-session UI, the setting is
 * not), and the mode's one-line consequence.
 *
 * ARIA radio-group pattern: the checked option is the group's single tab stop
 * and ArrowLeft/Up / ArrowRight/Down / Home / End move both focus and the
 * selection, exactly like a native radio set. Mirrors `shell/TabStrip.tsx`'s
 * roving tabindex, which is the tabs pattern; a mode is a value, not a view,
 * so this is radios.
 */
export function AnonymizerModeControl(props: AnonymizerModeControlProps): JSX.Element {
  const [pending, setPending] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  let group: HTMLDivElement | undefined;

  const select = (mode: AnonymizerMode): void => {
    if (mode === props.mode || pending() || props.disabled) return;
    if (
      mode === 'none' &&
      props.agentConnected &&
      !window.confirm('Turn the anonymizer off? The connected agent will read raw log text.')
    ) {
      return;
    }
    setError(null);
    setPending(true);
    props
      .onChange(mode)
      .catch((e: unknown) => setError(String(e)))
      .finally(() => setPending(false));
  };

  const focusOption = (mode: AnonymizerMode): void => {
    group?.querySelector<HTMLElement>(`[role="radio"][data-mode="${mode}"]`)?.focus();
  };

  const onKeyDown = (event: KeyboardEvent): void => {
    const current = ANONYMIZER_MODE_OPTIONS.indexOf(props.mode);
    const last = ANONYMIZER_MODE_OPTIONS.length - 1;
    let next: number;
    if (event.key === 'ArrowRight' || event.key === 'ArrowDown') next = current >= last ? 0 : current + 1;
    else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') next = current <= 0 ? last : current - 1;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = last;
    else return;
    event.preventDefault();
    const mode = ANONYMIZER_MODE_OPTIONS[next];
    focusOption(mode);
    select(mode);
  };

  return (
    <div class={styles.modeBlock}>
      <div class={styles.modeRow}>
        <div
          ref={group}
          class={styles.modeGroup}
          role="radiogroup"
          aria-label="Anonymizer mode"
          aria-busy={pending() || undefined}
          onKeyDown={onKeyDown}
        >
          <For each={ANONYMIZER_MODE_OPTIONS}>
            {(mode) => (
              <button
                type="button"
                role="radio"
                class={styles.modeOption}
                classList={{ [styles.modeOptionChecked]: props.mode === mode }}
                aria-checked={props.mode === mode}
                tabIndex={props.mode === mode ? 0 : -1}
                data-mode={mode}
                // Not disabled while `pending()`: disabling the focused option
                // drops keyboard focus mid-arrow-key. `select` ignores the
                // click instead and the group says `aria-busy`.
                disabled={props.disabled}
                onClick={() => select(mode)}
              >
                {MODE_LABEL[mode]}
              </button>
            )}
          </For>
        </div>
        <span class={styles.modeCaption}>Applies to every session</span>
      </div>
      <div
        class={styles.modeDescription}
        classList={{ [styles.modeDescriptionWarn]: props.mode === 'none' }}
        data-testid="anonymizer-mode-description"
      >
        {MODE_LABEL[props.mode]} — {MODE_DESCRIPTION[props.mode]}
        <Show when={props.mode === 'none' && props.bridgeRunning}>
          {' '}
          {AGENTS_READ_RAW_WARNING}
        </Show>
      </div>
      <Show when={error()}>
        {(message) => (
          <div class={styles.errorRow} role="alert">
            Could not change the mode — {message()}
          </div>
        )}
      </Show>
    </div>
  );
}
