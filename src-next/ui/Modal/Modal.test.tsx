// @vitest-environment jsdom
/**
 * U57 — Modal.tsx lacked dialog semantics and focus management: no
 * role="dialog"/aria-modal/aria-labelledby, no initial focus move, no Tab
 * focus trap, and no focus restore on close. Every app dialog is built on
 * this primitive, so the fix is applied here rather than per-consumer.
 *
 * Note: this repo does not depend on @testing-library/jest-dom, so
 * assertions use plain DOM property/attribute checks rather than the
 * toHaveAttribute/toHaveFocus matchers.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { Modal } from './Modal';

afterEach(() => {
  cleanup();
});

describe('[U57] Modal accessibility and focus management', () => {
  it('renders dialog role, aria-modal, and aria-labelledby pointing at the title', () => {
    render(
      <Modal open onClose={() => {}} title="My Dialog">
        <button>inside</button>
      </Modal>
    );

    const dialog = screen.getByRole('dialog');
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    const labelledBy = dialog.getAttribute('aria-labelledby');
    expect(labelledBy).toBeTruthy();
    expect(document.getElementById(labelledBy!)?.textContent).toBe('My Dialog');
  });

  it('moves focus into the modal on open', () => {
    render(
      <Modal open onClose={() => {}} title="Focus Test">
        <button>first</button>
        <button>second</button>
      </Modal>
    );

    expect(document.activeElement).toBe(screen.getByText('first'));
  });

  it('restores focus to the previously focused element on close', () => {
    const trigger = document.createElement('button');
    trigger.textContent = 'trigger';
    document.body.appendChild(trigger);
    trigger.focus();
    expect(document.activeElement).toBe(trigger);

    const { rerender } = render(
      <Modal open onClose={() => {}} title="Restore Test">
        <button>inside</button>
      </Modal>
    );

    expect(document.activeElement).not.toBe(trigger);

    rerender(
      <Modal open={false} onClose={() => {}} title="Restore Test">
        <button>inside</button>
      </Modal>
    );

    expect(document.activeElement).toBe(trigger);
    trigger.remove();
  });

  it('traps Tab focus within the modal, wrapping from last to first', () => {
    render(
      <Modal open onClose={() => {}} title="Trap Test">
        <button>first</button>
        <button>second</button>
      </Modal>
    );

    const last = screen.getByText('second');
    last.focus();
    expect(document.activeElement).toBe(last);

    fireEvent.keyDown(document, { key: 'Tab' });
    expect(document.activeElement).toBe(screen.getByText('first'));
  });

  it('traps Shift+Tab focus, wrapping from first to last', () => {
    render(
      <Modal open onClose={() => {}} title="Trap Test">
        <button>first</button>
        <button>second</button>
      </Modal>
    );

    const first = screen.getByText('first');
    expect(document.activeElement).toBe(first);

    fireEvent.keyDown(document, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(screen.getByText('second'));
  });

  it('calls onClose on Escape', () => {
    const onClose = vi.fn();
    render(
      <Modal open onClose={onClose} title="Escape Test">
        <button>inside</button>
      </Modal>
    );

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
