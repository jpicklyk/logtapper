/** @jsxImportSource solid-js */
/**
 * Agent presence: the orb stage, raw-access banner, shared-focus indicator,
 * pending navigation requests, the activity feed, and the phase-2b consent
 * placeholder.
 *
 * The shell decides *where* this lands — its own column on wide, inside
 * `details` on standard, a rail drawer on compact — via `slots.presence`
 * (S1's `surfaces.ts`). Nothing here reads the tier, and hiding the panel is
 * the shell's job too (its per-region collapse), so there is no panel-local
 * collapsed mode.
 */
import { For, Show, createMemo } from 'solid-js';
import type { JSX } from 'solid-js';
import { Orb } from './Orb';
import type { AgentOrbState } from './agentState';
import { ActivityFeed, isAgent } from './ActivityFeed';
import type { PresenceStore } from './presenceStore';
import styles from './presence.module.css';

/** Orb diameter on the stage that leads the expanded panel — the animation is the point of
 *  the surface, so it gets a dedicated block at the top rather than a header icon. */
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

export function PresencePanel(props: PresencePanelProps): JSX.Element {
  const store = () => props.store;
  const state = createMemo<AgentOrbState>(() => store().agent.state());
  const stateText = createMemo(() => STATE_TEXT[state()]);

  /**
   * The connected agent's own name, from its most recent request or journal
   * entry — there is no separate "who is attached" call, and an agent that
   * has never acted has no name to show.
   */
  const clientName = createMemo(() => store().agent.client() ?? 'Agent');

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
      aria-label="Agent presence"
    >
      <div class={styles.stage} data-testid="agent-stage">
        <Orb state={state()} size={STAGE_ORB_SIZE} title={`${clientName()}: ${stateText()}`} />
        <span class={styles.stageCaption}>
          <span class={styles.stageClient}>{clientName()}</span>
          <span class={styles.stageState}>{stateText()}</span>
        </span>
      </div>

      {/* Keyed off the backend's `effectiveAgentRaw`, not the raw-access
          checkbox alone: the anonymizer mode `None` opens the same door, and
          the backend is the one place the two gates are combined. */}
      <Show when={store().effectiveAgentRaw()}>
        <div class={styles.rawBanner} role="status" data-testid="raw-banner">
          <strong class={styles.rawTitle}>
            {store().agentRawAccess() ? 'Raw access ON' : 'Anonymizer OFF'}
          </strong>
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
      {/* Agent activity only: the user already knows what they did, and their
          rows (session opens, workspace loads) swamped the agent's. The journal
          itself still records both — agents read it through the MCP activity
          tool — so this is a display choice, not a data one. */}
      <ActivityFeed
        entries={store().entries().filter((entry) => isAgent(entry.caller))}
        sessionName={store().sessionName}
        onNavigate={store().navigate}
        now={props.now}
      />

      <div class={styles.consentPlaceholder} data-testid="consent-placeholder">
        Consent requests appear here
      </div>
    </section>
  );
}
