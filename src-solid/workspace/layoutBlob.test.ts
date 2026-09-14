import { describe, expect, it } from 'vitest';
import {
  MAX_SPLIT_RATIO,
  MIN_SPLIT_RATIO,
  REACT_LAYOUT_KEYS,
  SOLID_LAYOUT_VERSION,
  emptySolidLayout,
  emptySplitLayout,
  readSolidLayout,
  writeSolidLayout,
} from './layoutBlob';
import type { SolidLayout } from './layoutBlob';

const layout: SolidLayout = {
  columns: { navigator: 300, details: 420 },
  collapsed: ['presence'],
  tabs: ['a.log', 'b.log'],
  activeTab: 'b.log',
  split: { active: true, secondarySessionId: 'session-b', ratio: 0.35 },
};

/**
 * A `layout.json` blob exactly as React's `workspacePersistence.savePersistedState`
 * writes it: the nine `PersistedState` keys, nothing else. (`REACT_LAYOUT_KEYS`
 * mirrors that interface — `workspacePersistence.ts` itself is not
 * framework-free, so it cannot be imported here; the key list is duplicated and
 * this fixture is the thing that keeps the duplicate honest.)
 */
function reactBlob(): Record<string, unknown> {
  return {
    centerTree: {
      type: 'leaf',
      pane: { id: 'p1', tabs: [{ id: 't1', type: 'logviewer', label: 'a.log', closable: true }], activeTabId: 't1' },
    },
    leftPaneWidth: 260,
    leftPaneTab: 'sections',
    rightPaneVisible: true,
    rightPaneWidth: 380,
    rightPaneTab: 'analyses',
    bottomPaneVisible: false,
    bottomPaneHeight: 200,
    bottomPaneTab: 'processors',
  };
}

describe('readSolidLayout', () => {
  it('returns null for a blob with no solid namespace', () => {
    expect(readSolidLayout(reactBlob())).toBeNull();
    expect(readSolidLayout(null)).toBeNull();
    expect(readSolidLayout(undefined)).toBeNull();
    expect(readSolidLayout('nonsense')).toBeNull();
    expect(readSolidLayout([1, 2, 3])).toBeNull();
  });

  it('ignores an unknown version rather than coercing it', () => {
    const blob = { solid: { v: 99, columns: { navigator: 300 }, collapsed: [], tabs: [], activeTab: null } };
    expect(readSolidLayout(blob)).toBeNull();
  });

  it('drops corrupt fields instead of throwing', () => {
    const blob = {
      solid: {
        v: SOLID_LAYOUT_VERSION,
        columns: { navigator: 300, details: 'wide', presence: Number.NaN },
        collapsed: ['presence', 7],
        tabs: null,
        activeTab: 42,
        split: { active: 'yes', secondarySessionId: 9, ratio: 'half' },
      },
    };
    expect(readSolidLayout(blob)).toEqual({
      columns: { navigator: 300 },
      collapsed: ['presence'],
      tabs: [],
      activeTab: null,
      split: emptySplitLayout(),
    });
  });

  it('defaults split when the key is absent (a pre-S1 save)', () => {
    const blob = {
      solid: { v: SOLID_LAYOUT_VERSION, columns: {}, collapsed: [], tabs: [], activeTab: null },
    };
    expect(readSolidLayout(blob)?.split).toEqual(emptySplitLayout());
  });

  it('clamps an out-of-range split ratio rather than dropping it', () => {
    const blob = {
      solid: {
        v: SOLID_LAYOUT_VERSION,
        columns: {},
        collapsed: [],
        tabs: [],
        activeTab: null,
        split: { active: true, secondarySessionId: 's', ratio: 0.95 },
      },
    };
    expect(readSolidLayout(blob)?.split.ratio).toBe(MAX_SPLIT_RATIO);

    const low = {
      solid: {
        v: SOLID_LAYOUT_VERSION,
        columns: {},
        collapsed: [],
        tabs: [],
        activeTab: null,
        split: { active: true, secondarySessionId: 's', ratio: 0.01 },
      },
    };
    expect(readSolidLayout(low)?.split.ratio).toBe(MIN_SPLIT_RATIO);
  });
});

describe('writeSolidLayout', () => {
  it('round-trips the layout it wrote', () => {
    expect(readSolidLayout(writeSolidLayout(null, layout))).toEqual(layout);
  });

  it('starts from an empty object when the blob is absent or not an object', () => {
    expect(Object.keys(writeSolidLayout(null, emptySolidLayout()))).toEqual(['solid']);
    expect(Object.keys(writeSolidLayout('corrupt', emptySolidLayout()))).toEqual(['solid']);
  });

  it("preserves all nine of React's keys byte-for-byte", () => {
    const before = reactBlob();
    const after = writeSolidLayout(before, layout);
    for (const key of REACT_LAYOUT_KEYS) {
      expect(after[key]).toEqual(before[key]);
    }
    // Deep equality over the whole React half, not just key-by-key presence.
    const { solid: _solid, ...rest } = after;
    expect(rest).toEqual(before);
  });

  it('preserves arbitrary unknown keys (a future frontend, a newer build)', () => {
    const before = { ...reactBlob(), svelte: { v: 3, panes: [1, 2] }, futureFlag: true, weird: null };
    const after = writeSolidLayout(before, layout);
    const { solid: _solid, ...rest } = after;
    expect(rest).toEqual(before);
  });

  it('replaces an existing solid namespace without disturbing its siblings', () => {
    const first = writeSolidLayout(reactBlob(), layout);
    const second = writeSolidLayout(first, { ...layout, activeTab: 'a.log', collapsed: [] });
    expect(readSolidLayout(second)).toEqual({ ...layout, activeTab: 'a.log', collapsed: [] });
    const { solid: _a, ...restSecond } = second;
    const { solid: _b, ...restFirst } = first;
    expect(restSecond).toEqual(restFirst);
  });

  it('does not alias the caller’s layout (a later mutation cannot leak in)', () => {
    const mutable: SolidLayout = {
      columns: { navigator: 300 },
      collapsed: [],
      tabs: ['a'],
      activeTab: 'a',
      split: { active: true, secondarySessionId: 'b', ratio: 0.4 },
    };
    const blob = writeSolidLayout(null, mutable);
    mutable.tabs.push('b');
    mutable.columns.navigator = 999;
    mutable.split.ratio = 0.9;
    expect(readSolidLayout(blob)).toEqual({
      columns: { navigator: 300 },
      collapsed: [],
      tabs: ['a'],
      activeTab: 'a',
      split: { active: true, secondarySessionId: 'b', ratio: 0.4 },
    });
  });
});

describe('.ltw compatibility with React', () => {
  /**
   * Stand-in for React's `loadPersistedState`: it reads exactly the nine keys
   * off the blob's top level and never looks at anything else. The real
   * function additionally clamps and validates, which cannot change whether a
   * value survived a Solid save — so this checks the only property that matters
   * here, that every value is still where React will look for it.
   */
  function reactLoad(blob: Record<string, unknown>): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const key of REACT_LAYOUT_KEYS) {
      if (blob[key] !== undefined) out[key] = blob[key];
    }
    return out;
  }

  it('a React-written blob still reads identically after a Solid save', () => {
    const written = reactBlob();
    const afterSolidSave = writeSolidLayout(written, layout);
    expect(reactLoad(afterSolidSave)).toEqual(reactLoad(written));
  });

  it('React sees nothing at all when Solid writes a blob from scratch', () => {
    expect(reactLoad(writeSolidLayout(null, layout))).toEqual({});
  });
});
