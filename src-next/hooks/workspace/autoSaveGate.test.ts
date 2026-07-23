import { describe, it, expect } from 'vitest';
import { createAutoSaveGate } from './autoSaveGate';

describe('createAutoSaveGate', () => {
  it('is not suppressed initially', () => {
    const gate = createAutoSaveGate();
    expect(gate.isSuppressed()).toBe(false);
    expect(gate.depth()).toBe(0);
  });

  it('suppresses between begin and end', () => {
    const gate = createAutoSaveGate();
    gate.beginRestore();
    expect(gate.isSuppressed()).toBe(true);
    gate.endRestore();
    expect(gate.isSuppressed()).toBe(false);
  });

  it('stays suppressed until the outermost restore ends', () => {
    // A workspace open can trigger a nested .lts import. A boolean flag would
    // let the inner completion re-enable saving mid-restore.
    const gate = createAutoSaveGate();
    gate.beginRestore();
    gate.beginRestore();
    gate.endRestore();
    expect(gate.isSuppressed()).toBe(true);
    gate.endRestore();
    expect(gate.isSuppressed()).toBe(false);
  });

  it('never drops below zero on a stray end', () => {
    const gate = createAutoSaveGate();
    gate.endRestore();
    gate.endRestore();
    expect(gate.depth()).toBe(0);
    // A later begin must still suppress — an unbalanced end must not leave the
    // counter negative and swallow the next restore.
    gate.beginRestore();
    expect(gate.isSuppressed()).toBe(true);
  });

  it('reset clears suppression regardless of depth', () => {
    const gate = createAutoSaveGate();
    gate.beginRestore();
    gate.beginRestore();
    gate.reset();
    expect(gate.isSuppressed()).toBe(false);
    expect(gate.depth()).toBe(0);
  });

  it('gates are independent instances', () => {
    const a = createAutoSaveGate();
    const b = createAutoSaveGate();
    a.beginRestore();
    expect(a.isSuppressed()).toBe(true);
    expect(b.isSuppressed()).toBe(false);
  });
});
