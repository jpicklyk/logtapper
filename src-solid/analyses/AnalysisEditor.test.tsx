/** @jsxImportSource solid-js */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@solidjs/testing-library';
import { createSignal } from 'solid-js';
import { EditorView } from '@codemirror/view';
import type { AnalysisArtifact, AnalysisSection, SourceReference } from '@bridge/types';
import { AnalysisEditor } from './AnalysisEditor';
import type { AnalysesStore } from './analysesStore';

// CodeMirror needs a Range geometry in jsdom — see createTextEditor.test.ts.
beforeAll(() => {
  const emptyRect = { top: 0, bottom: 0, left: 0, right: 0, width: 0, height: 0, x: 0, y: 0 };
  Range.prototype.getBoundingClientRect = () => emptyRect as DOMRect;
  Range.prototype.getClientRects = () => Object.assign([], { item: () => null }) as unknown as DOMRectList;
});

afterEach(cleanup);

function artifact(id: string, overrides: Partial<AnalysisArtifact> = {}): AnalysisArtifact {
  return { id, title: `Title ${id}`, createdAt: Date.now(), sections: [], ...overrides };
}

/** Type into the Nth mounted section body editor — same recovery pattern as
 *  `EditorTab.test.tsx` (the component exposes no handle). */
function typeInSection(container: Element, index: number, text: string): void {
  const host = container.querySelectorAll('.cm-editor')[index] as HTMLElement;
  const view = EditorView.findFromDOM(host);
  if (!view) throw new Error('no CodeMirror view mounted');
  view.dispatch({ changes: { from: 0, to: 0, insert: text } });
}

function fakeStore(overrides: {
  selected?: AnalysisArtifact;
  cursorReference?: SourceReference | null;
  takeDraftSeed?: SourceReference | null;
} = {}): AnalysesStore {
  const [selected] = createSignal(overrides.selected);
  return {
    list: () => [],
    loading: () => false,
    error: () => null,
    labels: () => new Map(),
    selectedId: () => selected()?.id ?? null,
    selected,
    select: vi.fn(),
    open: vi.fn(() => Promise.resolve(artifact('x'))),
    publish: vi.fn((draft) => Promise.resolve(artifact('new', draft))),
    update: vi.fn((draft) => Promise.resolve(artifact(draft.artifactId, draft))),
    remove: vi.fn(() => Promise.resolve()),
    cursorReference: vi.fn(() => overrides.cursorReference ?? null),
    captureDraftSeed: vi.fn(),
    takeDraftSeed: vi.fn(() => overrides.takeDraftSeed ?? null),
    jumpTo: vi.fn(),
    dispose: vi.fn(),
  };
}

describe('AnalysisEditor', () => {
  describe('validation', () => {
    it('disables Publish when the title is empty', () => {
      render(() => <AnalysisEditor store={fakeStore()} artifactId={null} onDone={vi.fn()} onCancel={vi.fn()} />);
      const button = screen.getByRole('button', { name: /publish/i }) as HTMLButtonElement;
      expect(button.disabled).toBe(true);
    });

    it('enables Publish once a title is present and at least one section exists', () => {
      render(() => <AnalysisEditor store={fakeStore()} artifactId={null} onDone={vi.fn()} onCancel={vi.fn()} />);
      fireEvent.input(screen.getByPlaceholderText(/what did you find/i), { target: { value: 'A finding' } });
      const button = screen.getByRole('button', { name: /publish/i }) as HTMLButtonElement;
      expect(button.disabled).toBe(false);
    });

    it('disables Publish again once the only section is removed', () => {
      render(() => <AnalysisEditor store={fakeStore()} artifactId={null} onDone={vi.fn()} onCancel={vi.fn()} />);
      fireEvent.input(screen.getByPlaceholderText(/what did you find/i), { target: { value: 'A finding' } });
      fireEvent.click(screen.getByTitle('Remove section'));
      const button = screen.getByRole('button', { name: /publish/i }) as HTMLButtonElement;
      expect(button.disabled).toBe(true);
    });
  });

  describe('publish payload', () => {
    it('publish() receives the title and section fields (heading, severity, references), not artifactId', async () => {
      const store = fakeStore({ takeDraftSeed: null });
      const onDone = vi.fn();
      const { container } = render(() => <AnalysisEditor store={store} artifactId={null} onDone={onDone} onCancel={vi.fn()} />);

      fireEvent.input(screen.getByPlaceholderText(/what did you find/i), { target: { value: 'A finding' } });
      fireEvent.input(screen.getByPlaceholderText(/section heading/i), { target: { value: 'Root cause' } });
      fireEvent.change(screen.getByDisplayValue('No severity'), { target: { value: 'Warning' } });
      typeInSection(container, 0, 'It crashed.');

      fireEvent.click(screen.getByRole('button', { name: /publish/i }));
      await Promise.resolve();
      await Promise.resolve();

      expect(store.publish).toHaveBeenCalledWith({
        title: 'A finding',
        sections: [{ heading: 'Root cause', body: 'It crashed.', references: [], severity: 'Warning' }],
      });
      expect(onDone).toHaveBeenCalledWith('new');
    });

    it('seeds the first section reference from a captured draft seed, exactly once', () => {
      const seed: SourceReference = { lineNumber: 12, endLine: null, label: 'Line 12', highlightType: 'Anchor', sessionId: 's1' };
      const store = fakeStore({ takeDraftSeed: seed });
      render(() => <AnalysisEditor store={store} artifactId={null} onDone={vi.fn()} onCancel={vi.fn()} />);
      expect(store.takeDraftSeed).toHaveBeenCalledTimes(1);
      expect(screen.getByDisplayValue('Line 12')).toBeTruthy();
    });

    it('editing an existing artifact calls update() with its id and the changed fields', async () => {
      const existing = artifact('a1', {
        title: 'Old title',
        sections: [{ heading: 'H', body: 'B', references: [], severity: null } as AnalysisSection],
      });
      const store = fakeStore({ selected: existing });
      const onDone = vi.fn();
      render(() => <AnalysisEditor store={store} artifactId="a1" onDone={onDone} onCancel={vi.fn()} />);

      fireEvent.input(screen.getByDisplayValue('Old title'), { target: { value: 'New title' } });
      fireEvent.click(screen.getByRole('button', { name: /update/i }));
      await Promise.resolve();
      await Promise.resolve();

      expect(store.update).toHaveBeenCalledWith({
        artifactId: 'a1',
        title: 'New title',
        sections: [{ heading: 'H', body: 'B', references: [], severity: null }],
      });
      expect(onDone).toHaveBeenCalledWith('a1');
    });

    it('adds a reference from the current cursor', () => {
      const cursorRef: SourceReference = { lineNumber: 99, endLine: null, label: 'Line 99', highlightType: 'Anchor', sessionId: 's1' };
      const store = fakeStore({ cursorReference: cursorRef });
      render(() => <AnalysisEditor store={store} artifactId={null} onDone={vi.fn()} onCancel={vi.fn()} />);
      fireEvent.click(screen.getByRole('button', { name: /reference from cursor/i }));
      expect(screen.getByDisplayValue('Line 99')).toBeTruthy();
    });
  });

  describe('dirty guard on cancel', () => {
    it('cancels without confirmation when nothing has changed', () => {
      const onCancel = vi.fn();
      const confirmSpy = vi.spyOn(globalThis, 'confirm');
      render(() => <AnalysisEditor store={fakeStore()} artifactId={null} onDone={vi.fn()} onCancel={onCancel} />);
      fireEvent.click(screen.getByRole('button', { name: /cancel/i }));
      expect(confirmSpy).not.toHaveBeenCalled();
      expect(onCancel).toHaveBeenCalledTimes(1);
    });

    it('asks for confirmation once the draft has been touched, and respects a decline', () => {
      const onCancel = vi.fn();
      const confirmSpy = vi.spyOn(globalThis, 'confirm').mockReturnValue(false);
      render(() => <AnalysisEditor store={fakeStore()} artifactId={null} onDone={vi.fn()} onCancel={onCancel} />);
      fireEvent.input(screen.getByPlaceholderText(/what did you find/i), { target: { value: 'A finding' } });
      fireEvent.click(screen.getByRole('button', { name: /cancel/i }));
      expect(confirmSpy).toHaveBeenCalledTimes(1);
      expect(onCancel).not.toHaveBeenCalled();
    });

    it('cancels once the user confirms discarding', () => {
      const onCancel = vi.fn();
      vi.spyOn(globalThis, 'confirm').mockReturnValue(true);
      render(() => <AnalysisEditor store={fakeStore()} artifactId={null} onDone={vi.fn()} onCancel={onCancel} />);
      fireEvent.input(screen.getByPlaceholderText(/what did you find/i), { target: { value: 'A finding' } });
      fireEvent.click(screen.getByRole('button', { name: /cancel/i }));
      expect(onCancel).toHaveBeenCalledTimes(1);
    });
  });
});
