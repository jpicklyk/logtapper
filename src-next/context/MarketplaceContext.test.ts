import { describe, it, expect } from 'vitest';
import { marketplaceReducer, initialState } from './MarketplaceContext';
import type { PackUpdateAvailable, MarketplacePackEntry } from '../bridge/types';

function makePackEntry(id: string): MarketplacePackEntry {
  return {
    id,
    name: `Pack ${id}`,
    version: '2.0.0',
    path: `packs/${id}.pack.yaml`,
    tags: [],
    sha256: '',
    processorIds: ['proc-a'],
  };
}

function makePackUpdate(packId: string): PackUpdateAvailable {
  return {
    packId,
    packName: `Pack ${packId}`,
    sourceName: 'official',
    installedVersion: '1.0.0',
    availableVersion: '2.0.0',
    newProcessorIds: ['new-proc'],
    entry: makePackEntry(packId),
  };
}

describe('marketplaceReducer — pack updates', () => {
  it('pack-updates:loaded replaces pendingPackUpdates', () => {
    const packUpdates = [makePackUpdate('wifi-diag')];
    const next = marketplaceReducer(initialState, { type: 'pack-updates:loaded', packUpdates });
    expect(next.pendingPackUpdates).toEqual(packUpdates);
  });

  it('pack-updates:decremented removes matching pack by packId', () => {
    const state = {
      ...initialState,
      pendingPackUpdates: [makePackUpdate('wifi-diag'), makePackUpdate('device-health')],
    };
    const next = marketplaceReducer(state, { type: 'pack-updates:decremented', packId: 'wifi-diag' });
    expect(next.pendingPackUpdates).toHaveLength(1);
    expect(next.pendingPackUpdates[0].packId).toBe('device-health');
  });

  it('pack-updates:decremented returns same ref when packId not found', () => {
    const state = {
      ...initialState,
      pendingPackUpdates: [makePackUpdate('wifi-diag')],
    };
    const next = marketplaceReducer(state, { type: 'pack-updates:decremented', packId: 'nonexistent' });
    expect(next).toBe(state);
  });

  it('updates:loaded does not affect pendingPackUpdates', () => {
    const packUpdates = [makePackUpdate('wifi-diag')];
    const state = { ...initialState, pendingPackUpdates: packUpdates };
    const next = marketplaceReducer(state, { type: 'updates:loaded', updates: [] });
    expect(next.pendingPackUpdates).toBe(packUpdates);
  });
});
