/** @jsxImportSource solid-js */
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@solidjs/testing-library';
import type { Caller } from '@bridge/types';
import { CallerBadge, callerClient, normalizeCaller } from './CallerBadge';
import type { CallerKind, CallerLike } from './CallerBadge';

afterEach(cleanup);

const UI_CALLER: Caller = { kind: 'ui' };
const AGENT_CALLER: Caller = { kind: 'agent', client: 'claude-code' };

describe('normalizeCaller', () => {
  const table: Array<[string, CallerLike, CallerKind]> = [
    ['artifact author "User"', 'User', 'human'],
    ['artifact author "Agent"', 'Agent', 'agent'],
    ['journal Caller { kind: ui }', UI_CALLER, 'human'],
    ['journal Caller { kind: agent }', AGENT_CALLER, 'agent'],
  ];

  it.each(table)('maps %s to %s', (_label, value, expected) => {
    expect(normalizeCaller(value)).toBe(expected);
  });
});

describe('callerClient', () => {
  it('returns the agent client only for the rich Caller shape', () => {
    expect(callerClient(AGENT_CALLER)).toBe('claude-code');
    expect(callerClient(UI_CALLER)).toBeNull();
    expect(callerClient('Agent')).toBeNull();
  });
});

describe('CallerBadge', () => {
  it('labels a human caller and takes the human token', () => {
    render(() => <CallerBadge caller="User" />);
    const badge = screen.getByText('You');

    expect(badge.getAttribute('data-caller')).toBe('human');
    expect(badge.style.getPropertyValue('--badge-color')).toBe('var(--caller-human)');
  });

  it('labels an agent caller and takes the agent token', () => {
    render(() => <CallerBadge caller={AGENT_CALLER} />);
    const badge = screen.getByText('Agent');

    expect(badge.getAttribute('data-caller')).toBe('agent');
    expect(badge.style.getPropertyValue('--badge-color')).toBe('var(--caller-agent)');
  });

  it('titles an agent badge with its client name', () => {
    render(() => <CallerBadge caller={AGENT_CALLER} />);
    expect(screen.getByText('Agent').getAttribute('title')).toBe('claude-code');
  });

  it('accepts an explicit label and title', () => {
    render(() => <CallerBadge caller="User" label="jpicklyk" title="Bookmarked by you" />);
    const badge = screen.getByText('jpicklyk');

    expect(badge.getAttribute('data-caller')).toBe('human');
    expect(badge.getAttribute('title')).toBe('Bookmarked by you');
  });
});
