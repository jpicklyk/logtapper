/**
 * Architecture contract tests for AppShell (M5 + M8 fixes).
 *
 * M5: Cache budget sync moved to HookWiring — AppShell must not import
 *     useCacheManager directly. These are static contract tests that guard
 *     the architecture boundary.
 *
 * M8: Workspace method refs (renameTab, setTabUnsaved) are stable
 *     useCallback([]) refs from useCenterTree. This test validates the
 *     underlying pure tree operations to document the contract.
 */
import { describe, it, expect } from 'vitest';

import appShellSource from './AppShell.tsx?raw';

import hookWiringSource from '../../context/index.tsx?raw';

import centerTreeSource from '../../hooks/workspace/useCenterTree.ts?raw';

// ---------------------------------------------------------------------------
// M5 — AppShell must not import useCacheManager
// ---------------------------------------------------------------------------

describe('M5: AppShell cache budget sync moved to HookWiring', () => {
  it('AppShell.tsx does not import useCacheManager', () => {
    expect(appShellSource).not.toContain('useCacheManager');
  });

  it('AppShell.tsx does not call cacheManager.setTotalBudget', () => {
    expect(appShellSource).not.toContain('setTotalBudget');
  });

  it('AppShell.tsx does not import from cache module', () => {
    // The cache import was removed — AppShell is now pure layout
    const cacheImportMatch = (appShellSource as string).match(/from ['"]\.\.\/\.\.\/cache['"]/);
    expect(cacheImportMatch).toBeNull();
  });
});

describe('M5: HookWiring contains cache budget sync', () => {
  it('context/index.tsx imports useSettings', () => {
    expect(hookWiringSource).toContain('useSettings');
  });

  it('context/index.tsx imports useCacheManager', () => {
    expect(hookWiringSource).toContain('useCacheManager');
  });

  it('context/index.tsx calls cacheManager.setTotalBudget in a useEffect', () => {
    // The sync must be inside a useEffect, not bare render logic
    expect(hookWiringSource).toContain('setTotalBudget');
    expect(hookWiringSource).toContain('useEffect');
    // Ensure the pattern is: useEffect + setTotalBudget (not just coincidental)
    const src = hookWiringSource as string;
    const effectIndex = src.indexOf('useEffect(() => {');
    const budgetIndex = src.indexOf('setTotalBudget');
    expect(effectIndex).toBeGreaterThan(-1);
    expect(budgetIndex).toBeGreaterThan(effectIndex);
  });
});

// ---------------------------------------------------------------------------
// M8 — Workspace callback ref stability: renameTab and setTabUnsaved
// ---------------------------------------------------------------------------

describe('M8: PaneContent receives destructured stable callback refs', () => {
  it('AppShell destructures setTabUnsaved and renameTab from workspace before portal render', () => {
    // Destructuring makes the ref stability explicit and safe
    expect(appShellSource).toContain('const { setTabUnsaved, renameTab } = workspace');
  });

  it('PaneContent receives destructured callback variables, not workspace.method inline', () => {
    // Should use `setTabUnsaved` (destructured), not `workspace.setTabUnsaved`
    expect(appShellSource).not.toContain('onDirtyChanged={workspace.setTabUnsaved}');
    expect(appShellSource).not.toContain('onFilePathChanged={workspace.renameTab}');
    expect(appShellSource).toContain('onDirtyChanged={setTabUnsaved}');
    expect(appShellSource).toContain('onFilePathChanged={renameTab}');
  });
});

// ---------------------------------------------------------------------------
// M8 — Verify useCenterTree callback deps guarantee stability
// ---------------------------------------------------------------------------

describe('M8: useCenterTree callback stability contract', () => {
  it('updateTree has an empty dependency array (stable root)', () => {
    // updateTree is the root dep for renameTab and setTabUnsaved
    // Empty dep array means it's created once and never recreated
    expect(centerTreeSource).toContain('const updateTree = useCallback(');
    expect(centerTreeSource).toContain('}, []);\n');
  });

  it('renameTab depends only on updateTree (inherits stability)', () => {
    // renameTab = useCallback(..., [updateTree]) → stable as long as updateTree is stable
    const renameTabMatch = (centerTreeSource as string).match(
      /const renameTab = useCallback[\s\S]*?}, \[updateTree\]\);/,
    );
    expect(renameTabMatch).not.toBeNull();
  });

  it('setTabUnsaved depends only on updateTree (inherits stability)', () => {
    const setTabUnsavedMatch = (centerTreeSource as string).match(
      /const setTabUnsaved = useCallback[\s\S]*?}, \[updateTree\]\);/,
    );
    expect(setTabUnsavedMatch).not.toBeNull();
  });
});
