import { createEffect, createMemo } from 'solid-js';
import type { Accessor } from 'solid-js';

/** Workspace mode (brief §2). Derived from the focused session's source. */
export type Mode = 'postmortem' | 'live';

/**
 * What the focused session is reading. `'live'` is an ADB logcat stream; every
 * file-backed source (dumpstate, bugreport, saved logcat, kernel, `.lts`) is
 * post-mortem. No session at all stays post-mortem — the workspace home and the
 * analysis surfaces are the sensible resting state.
 */
export type SessionKind = 'file' | 'live' | null | undefined;

export function modeForKind(kind: SessionKind): Mode {
  return kind === 'live' ? 'live' : 'postmortem';
}

export interface CreateModeOptions {
  sessionKind: Accessor<SessionKind>;
  root?: HTMLElement;
}

/** Live mode accessor, mirrored onto `data-mode` so CSS can branch on it. */
export function createMode(options: CreateModeOptions): Accessor<Mode> {
  const mode = createMemo(() => modeForKind(options.sessionKind()));
  createEffect(() => {
    (options.root ?? document.documentElement).setAttribute('data-mode', mode());
  });
  return mode;
}
