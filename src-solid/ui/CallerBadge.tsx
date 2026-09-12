/** @jsxImportSource solid-js */
import type { JSX } from 'solid-js';
import type { Caller } from '@bridge/types';
import styles from './ui.module.css';

/**
 * Who did a thing, reduced to the only distinction the UI draws.
 *
 * The backend spells this two ways and neither is a UI concern: artifacts
 * (bookmarks, analyses, watches) carry the `'User' | 'Agent'` string their
 * Rust enum serializes to, while the activity journal carries the richer
 * `Caller` (`{ kind: 'ui' }` / `{ kind: 'agent', client }`). Both collapse here,
 * so a surface never branches on which shape it happens to hold.
 */
export type CallerKind = 'human' | 'agent';

/** Either backend spelling of "who". */
export type CallerLike = 'User' | 'Agent' | Caller;

export function normalizeCaller(value: CallerLike): CallerKind {
  if (typeof value === 'string') return value === 'Agent' ? 'agent' : 'human';
  return value.kind === 'agent' ? 'agent' : 'human';
}

/** The agent's client name, when the value carries one. */
export function callerClient(value: CallerLike): string | null {
  if (typeof value === 'string') return null;
  return value.kind === 'agent' ? value.client : null;
}

export interface CallerBadgeProps {
  caller: CallerLike;
  /** Override the badge text. Defaults to "You" / "Agent". */
  label?: string;
  title?: string;
}

const DEFAULT_LABEL: Record<CallerKind, string> = { human: 'You', agent: 'Agent' };

/**
 * A one-word attribution chip. The colour is the only thing that varies, and it
 * arrives as a custom property so the stylesheet keeps every visual decision.
 */
export function CallerBadge(props: CallerBadgeProps) {
  const kind = (): CallerKind => normalizeCaller(props.caller);
  const text = (): string => props.label ?? DEFAULT_LABEL[kind()];
  const tooltip = (): string => props.title ?? callerClient(props.caller) ?? text();

  return (
    <span
      class={styles.callerBadge}
      data-caller={kind()}
      title={tooltip()}
      style={
        { '--badge-color': `var(--caller-${kind()})` } as JSX.CSSProperties
      }
    >
      {text()}
    </span>
  );
}
