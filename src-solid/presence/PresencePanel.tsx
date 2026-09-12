/** @jsxImportSource solid-js */
/**
 * Agent presence: a collapsed pill (orb + state text) or the expanded panel
 * (header, raw-access banner, shared-focus indicator, pending navigation
 * requests, the activity feed, and the phase-2b consent placeholder).
 *
 * The shell decides *where* this lands — its own column on wide, inside
 * `details` on standard, a rail drawer on compact — via `slots.presence`
 * (S1's `surfaces.ts`). Nothing here reads the tier; collapsed/expanded is the
 * user's own choice and is persisted per browser profile.
 */
import { For, Show, createMemo, createSignal } from 'solid-js';
import type { JSX } from 'solid-js';
import { Orb } from './Orb';
import type { AgentOrbState } from './agentState';
import { ActivityFeed } from './ActivityFeed';
import type { PresenceStore } from './presenceStore';
import styles from './presence.module.css';

/** localStorage key for the collapsed/expanded choice. */
export const COLLAPSED_STORAGE_KEY = 'logtapper-presence-collapsed';

/** Orb diameter in the collapsed pill (brief §5 / the canvas board). */
const PILL_ORB_SIZE = 20;
/** Orb diameter on the stage at the bottom of the expanded panel — the animation is the
 *  point of the surface, so it gets a dedicated block rather than a header icon. */
const STAGE_ORB_SIZE = 200;

/** Orb state → the words next to it. */
const STATE_TEXT: Readonly<Record<AgentOrbState, string>> = {
  detached: 'detached',
  idle: 'idle',
  reading: 'reading',
  running: 'running',
  wrote: 'wrote',
  needs: 'needs you',
  raw: 'raw access on',
};

export interface PresencePanelProps {
  store: PresenceStore;
  /** Injectable clock for the feed's relative times (tests). */
  now?: () => number;
}

function readCollapsed(): boolean {
  try {
    return localStorage.getItem(COLLAPSED_STORAGE_KEY) === 'true';
  } catch {
    return false;
  }
}

function writeCollapsed(value: boolean): void {
  try {
    localStorage.setItem(COLLAPSED_STORAGE_KEY, String(value));
  } catch {
    // Blocked storage: the toggle still works for this session.
  }
}

export function PresencePanel(props: PresencePanelProps): JSX.Element {
  const [collapsed, setCollapsed] = createSignal(readCollapsed());

  const store = () => props.store;
  const state = createMemo<AgentOrbState>(() => store().agent.state());
  const stateText = createMemo(() => STATE_TEXT[state()]);

  /**
   * The connected agent's own name, straight from the journal's caller
   * identity — there is no separate "who is attached" call, and an agent that
   * has never acted has no name to show.
   */
  const clientName = createMemo(() => {
    const entry = store().agent.lastAgentEntry();
    return entry && entry.caller.kind === 'agent' ? entry.caller.client : 'Agent';
  });

  const toggle = (): void => {
    const next = !collapsed();
    setCollapsed(next);
    writeCollapsed(next);
  };

  const focusText = createMemo(() => {
    const focus = store().focus();
    if (!focus) return null;
    const parts = [store().sessionName(focus.sessionId)];
    if (focus.line !== null) parts.push(`line ${focus.line}`);
    if (focus.section !== null) parts.push(focus.section);
    return parts.join(' · ');
  });

  return (
    <section
      class={styles.panel}
      data-state={state()}
      data-collapsed={collapsed() ? 'true' : 'false'}
      aria-label="Agent presence"
    >
      <Show
        when={!collapsed()}
        fallback={
          <button
            type="button"
            class={styles.pill}
            onClick={toggle}
            aria-expanded={false}
            title={`${clientName()} · ${stateText()}`}
          >
            <Orb state={state()} size={PILL_ORB_SIZE} />
            <span class={styles.pillText}>
              {clientName()} · {stateText()}
            </span>
          </button>
        }
      >
        <header class={styles.header}>
          <span class={styles.headerNames}>
            <span class={styles.headerClient}>{clientName()}</span>
            <span class={styles.headerState}>{stateText()}</span>
          </span>
          <button type="button" class={styles.ghostButton} onClick={toggle} aria-expanded>
            Collapse
          </button>
        </header>

        <Show when={store().agentRawAccess()}>
          <div class={styles.rawBanner} role="status" data-testid="raw-banner">
            <strong class={styles.rawTitle}>Raw access ON</strong>
            <span class={styles.rawBody}>
              {clientName()} reads un-anonymized log text — emails, IPs, IMEIs and serials are not
              tokenized.
            </span>
          </div>
        </Show>

        <Show when={focusText()}>
          {(text) => (
            <div class={styles.focusBar} data-testid="focus-indicator">
              <span class={styles.focusLabel}>Focus</span>
              <span class={styles.focusTarget}>{text()}</span>
              <button
                type="button"
                class={styles.ghostButton}
                onClick={() => void store().clearFocus()}
              >
                Clear
              </button>
            </div>
          )}
        </Show>

        <div class={styles.requests}>
          <label class={styles.confirmToggle}>
            <input
              type="checkbox"
              checked={store().requireNavConfirmation()}
              onChange={(event) =>
                store().setRequireNavConfirmation(event.currentTarget.checked)
              }
            />
            Confirm agent navigation requests
          </label>
          <For each={store().pendingNav()}>
            {(request) => (
              <article
                class={styles.requestCard}
                data-testid="nav-request"
                data-held={store().isNavHeld(request.id) ? 'true' : 'false'}
              >
                <p class={styles.requestReason}>{request.reason}</p>
                <p class={styles.requestTarget}>
                  {store().sessionName(request.sessionId)}
                  <Show when={request.line !== null}> · line {request.line}</Show>
                  <Show when={request.analysisId !== null}> · {request.analysisId}</Show>
                </p>
                <div class={styles.requestActions}>
                  <button
                    type="button"
                    class={styles.primaryButton}
                    onClick={() => store().applyNav(request.id)}
                  >
                    Apply
                  </button>
                  <button
                    type="button"
                    class={styles.ghostButton}
                    disabled={store().isNavHeld(request.id)}
                    onClick={() => store().holdNav(request.id)}
                  >
                    Hold
                  </button>
                  <button
                    type="button"
                    class={styles.ghostButton}
                    onClick={() => store().dismissNav(request.id)}
                  >
                    Dismiss
                  </button>
                </div>
              </article>
            )}
          </For>
        </div>

        <h2 class={styles.sectionTitle}>Activity</h2>
        <ActivityFeed
          entries={store().entries()}
          sessionName={store().sessionName}
          onNavigate={store().navigate}
          now={props.now}
        />

        <div class={styles.consentPlaceholder} data-testid="consent-placeholder">
          Consent requests appear here
        </div>

        <div class={styles.stage} data-testid="agent-stage">
          <Orb state={state()} size={STAGE_ORB_SIZE} title={`${clientName()}: ${stateText()}`} />
          <span class={styles.stageCaption}>
            <span class={styles.stageClient}>{clientName()}</span>
            <span class={styles.stageState}>{stateText()}</span>
          </span>
        </div>
      </Show>
    </section>
  );
}
