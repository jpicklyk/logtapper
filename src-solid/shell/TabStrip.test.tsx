/** @jsxImportSource solid-js */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@solidjs/testing-library';
import { createSignal } from 'solid-js';
import { TabStrip } from './TabStrip';
import type { TabDescriptor } from './TabStrip';

afterEach(cleanup);

const TABS: TabDescriptor[] = [
  { key: 'a', label: 'alpha.log', kind: 'session', closable: true },
  { key: 'b', label: 'bravo.log', kind: 'session', closable: true },
  { key: 'notes', label: 'notes.md', kind: 'editor', dirty: true, closable: true },
];

function mount(
  overrides: Partial<{
    tabs: TabDescriptor[];
    activeKey: string | null;
    onSelect: (key: string) => void;
    onClose: (key: string) => void;
  }> = {},
) {
  const onSelect = overrides.onSelect ?? vi.fn();
  const onClose = overrides.onClose ?? vi.fn();
  const tabs = overrides.tabs ?? TABS;
  const [activeKey, setActiveKey] = createSignal<string | null>(
    overrides.activeKey === undefined ? 'a' : overrides.activeKey,
  );
  render(() => (
    <TabStrip tabs={tabs} activeKey={activeKey()} onSelect={onSelect} onClose={onClose} />
  ));
  return { onSelect, onClose, setActiveKey };
}

function tabEl(key: string): HTMLElement {
  const el = document.querySelector(`[data-key="${key}"]`);
  if (!el) throw new Error(`no tab ${key}`);
  return el as HTMLElement;
}

describe('TabStrip', () => {
  it('renders one tab per descriptor, in order, marking the active one', () => {
    mount();
    const rendered = screen.getAllByRole('tab');

    expect(rendered.map((el) => el.textContent)).toEqual([
      'alpha.log×',
      'bravo.log×',
      'notes.md●×',
    ]);
    expect(rendered[0].getAttribute('aria-selected')).toBe('true');
    expect(rendered[1].getAttribute('aria-selected')).toBe('false');
    expect(rendered[2].getAttribute('data-kind')).toBe('editor');
  });

  it('selects on click', () => {
    const { onSelect } = mount();
    fireEvent.click(tabEl('b'));
    expect(onSelect).toHaveBeenCalledWith('b');
  });

  it('closes from the close button without also selecting', () => {
    const { onSelect, onClose } = mount();
    fireEvent.click(screen.getByRole('button', { name: 'Close bravo.log' }));

    expect(onClose).toHaveBeenCalledWith('b');
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('closes on middle-click', () => {
    const { onClose } = mount();
    tabEl('b').dispatchEvent(new MouseEvent('auxclick', { button: 1, bubbles: true }));
    expect(onClose).toHaveBeenCalledWith('b');
  });

  it('ignores a right-click aux button', () => {
    const { onClose } = mount();
    tabEl('b').dispatchEvent(new MouseEvent('auxclick', { button: 2, bubbles: true }));
    expect(onClose).not.toHaveBeenCalled();
  });

  it('renders no close affordance for a pinned tab', () => {
    const { onClose } = mount({
      tabs: [{ key: 'a', label: 'alpha.log', kind: 'session', closable: false }],
    });

    expect(screen.queryByRole('button', { name: /close/i })).toBeNull();
    tabEl('a').dispatchEvent(new MouseEvent('auxclick', { button: 1, bubbles: true }));
    expect(onClose).not.toHaveBeenCalled();
  });

  it('cycles forward on Ctrl+Tab and wraps', () => {
    const { onSelect, setActiveKey } = mount();

    fireEvent.keyDown(window, { key: 'Tab', ctrlKey: true });
    expect(onSelect).toHaveBeenLastCalledWith('b');

    setActiveKey('notes');
    fireEvent.keyDown(window, { key: 'Tab', ctrlKey: true });
    expect(onSelect).toHaveBeenLastCalledWith('a');
  });

  it('cycles backward on Ctrl+Shift+Tab and wraps', () => {
    const { onSelect, setActiveKey } = mount();

    fireEvent.keyDown(window, { key: 'Tab', ctrlKey: true, shiftKey: true });
    expect(onSelect).toHaveBeenLastCalledWith('notes');

    setActiveKey('b');
    fireEvent.keyDown(window, { key: 'Tab', ctrlKey: true, shiftKey: true });
    expect(onSelect).toHaveBeenLastCalledWith('a');
  });

  it('leaves a plain Tab and Cmd+Tab alone', () => {
    const { onSelect } = mount();

    fireEvent.keyDown(window, { key: 'Tab' });
    fireEvent.keyDown(window, { key: 'Tab', metaKey: true });

    expect(onSelect).not.toHaveBeenCalled();
  });

  it('does not cycle with fewer than two tabs', () => {
    const { onSelect } = mount({
      tabs: [{ key: 'a', label: 'alpha.log', kind: 'session', closable: true }],
    });

    fireEvent.keyDown(window, { key: 'Tab', ctrlKey: true });

    expect(onSelect).not.toHaveBeenCalled();
  });

  it('stops listening once unmounted', () => {
    const { onSelect } = mount();
    cleanup();

    fireEvent.keyDown(window, { key: 'Tab', ctrlKey: true });

    expect(onSelect).not.toHaveBeenCalled();
  });
});
