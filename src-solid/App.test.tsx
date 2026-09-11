/** @jsxImportSource solid-js */
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@solidjs/testing-library';
import { App } from './App';

vi.mock('@tauri-apps/plugin-dialog', () => ({ open: vi.fn() }));
vi.mock('@bridge/commands', () => ({ getLines: vi.fn(), loadLogFile: vi.fn() }));

describe('App', () => {
  it('renders the scaffold heading', () => {
    render(() => <App />);
    expect(screen.getByRole('heading', { name: /solid scaffold/i })).toBeTruthy();
  });
});
