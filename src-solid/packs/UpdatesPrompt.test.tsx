/** @jsxImportSource solid-js */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@solidjs/testing-library';
import { createSignal } from 'solid-js';
import type { PackUpdateAvailable, UpdateAvailable } from '@bridge/types';
import { UpdatesPrompt } from './UpdatesPrompt';
import type { PacksStore, UpdateAllOutcome } from './packsStore';

afterEach(cleanup);

const procUpdate = (id: string, sourceName = 'official'): UpdateAvailable =>
  ({ processorId: id, processorName: `Name ${id}`, sourceName, installedVersion: '1.0.0', availableVersion: '1.1.0' } as UpdateAvailable);
const packUpdate = (id: string, sourceName = 'official'): PackUpdateAvailable =>
  ({ packId: id, packName: `Pack ${id}`, sourceName, installedVersion: '1.0.0', availableVersion: '2.0.0', newProcessorIds: [] } as PackUpdateAvailable);

/** A reactive `PacksStore` double covering only what the prompt reads. */
function fakeStore(opts: {
  updates?: UpdateAvailable[];
  packUpdates?: PackUpdateAvailable[];
  outcome?: UpdateAllOutcome;
  errors?: Record<string, string>;
} = {}) {
  const [updates, setUpdates] = createSignal(opts.updates ?? []);
  const [packUpdates, setPackUpdates] = createSignal(opts.packUpdates ?? []);
  const [updatingAll, setUpdatingAll] = createSignal(false);
  const [progress, setProgress] = createSignal({ done: 0, total: 0 });
  const outcome = opts.outcome ?? { failedProcessorIds: [], failedPackIds: [] };
  const dismissUpdatePrompt = vi.fn();
  const updateAll = vi.fn(async () => {
    setUpdatingAll(true);
    setProgress({ done: 1, total: 2 });
    await Promise.resolve();
    // What the real store does: whatever did not fail leaves the lists.
    setUpdates((list) => list.filter((u) => outcome.failedProcessorIds.includes(u.processorId)));
    setPackUpdates((list) => list.filter((u) => outcome.failedPackIds.includes(u.packId)));
    setUpdatingAll(false);
    return outcome;
  });
  const store = {
    pendingUpdates: updates,
    pendingPackUpdates: packUpdates,
    updatingAll,
    updateAllProgress: progress,
    errorFor: (id: string) => opts.errors?.[id],
    dismissUpdatePrompt,
    updateAll,
  } as unknown as PacksStore;
  return { store, dismissUpdatePrompt, updateAll };
}

describe('UpdatesPrompt', () => {
  it('summarises counts and sources and lists every pending item with its version jump', () => {
    const { store } = fakeStore({ updates: [procUpdate('a'), procUpdate('b', 'team')], packUpdates: [packUpdate('p')] });
    render(() => <UpdatesPrompt store={store} />);
    const dialog = screen.getByRole('dialog');
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    expect(dialog.textContent).toContain('2 analyzer updates and 1 pack update from official, team.');
    expect(dialog.textContent).toContain('Pack p');
    expect(dialog.textContent).toContain('1.0.0 → 2.0.0');
    expect(dialog.textContent).toContain('Name b');
  });

  it('focuses Update all on mount, and Later / Escape dismiss through the store', () => {
    const { store, dismissUpdatePrompt } = fakeStore({ updates: [procUpdate('a')] });
    render(() => <UpdatesPrompt store={store} />);
    expect(document.activeElement?.textContent).toBe('Update all');
    fireEvent.click(screen.getByText('Later'));
    expect(dismissUpdatePrompt).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(dismissUpdatePrompt).toHaveBeenCalledTimes(2);
  });

  it('Update all runs the store and dismisses when everything succeeded', async () => {
    const { store, dismissUpdatePrompt, updateAll } = fakeStore({ updates: [procUpdate('a')] });
    render(() => <UpdatesPrompt store={store} />);
    fireEvent.click(screen.getByText('Update all'));
    expect(updateAll).toHaveBeenCalledTimes(1);
    await Promise.resolve();
    await Promise.resolve();
    expect(dismissUpdatePrompt).toHaveBeenCalledTimes(1);
  });

  it('stays open after failures, names the count, shows the item error, and offers only Close', async () => {
    const { store, dismissUpdatePrompt } = fakeStore({
      updates: [procUpdate('a'), procUpdate('b')],
      outcome: { failedProcessorIds: ['b'], failedPackIds: [] },
      errors: { b: 'checksum mismatch' },
    });
    render(() => <UpdatesPrompt store={store} />);
    fireEvent.click(screen.getByText('Update all'));
    await Promise.resolve();
    await Promise.resolve();
    expect(dismissUpdatePrompt).not.toHaveBeenCalled();
    expect(screen.getByRole('alert').textContent).toContain('1 update failed and is still pending');
    expect(screen.getByRole('dialog').textContent).toContain('checksum mismatch');
    expect(screen.queryByText('Update all')).toBeNull();
    expect(screen.queryByText('Later')).toBeNull();
    fireEvent.click(screen.getByText('Close'));
    expect(dismissUpdatePrompt).toHaveBeenCalledTimes(1);
  });
});
