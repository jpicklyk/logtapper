/** @jsxImportSource solid-js */
import { createSignal } from 'solid-js';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render } from '@solidjs/testing-library';
import { Orb } from './Orb';
import { generateOrbGeometry } from './orbGeometry';
import type { AgentOrbState } from './agentState';

// vitest `globals` is off, so @solidjs/testing-library's auto-cleanup never
// registers — unmount explicitly or renders stack up across tests (matches
// the pattern in App.test.tsx / LogViewer.test.tsx).
afterEach(cleanup);

const STATES: AgentOrbState[] = ['detached', 'idle', 'reading', 'running', 'wrote', 'needs', 'raw'];

describe('Orb', () => {
  it('renders the orb root with the state modifier class and colour token', () => {
    const { container } = render(() => <Orb state="reading" size={44} />);
    const root = container.querySelector('.orb');
    expect(root).toBeTruthy();
    expect(root!.classList.contains('orb--reading')).toBe(true);
    expect((root as HTMLElement).style.getPropertyValue('--orb-c')).toBe('var(--agent-reading)');
    expect((root as HTMLElement).style.getPropertyValue('--orb-size')).toBe('44px');
  });

  it("detached state's colour token reuses --agent-idle", () => {
    const { container } = render(() => <Orb state="detached" size={44} />);
    const root = container.querySelector('.orb') as HTMLElement;
    expect(root.style.getPropertyValue('--orb-c')).toBe('var(--agent-idle)');
    expect(root.classList.contains('orb--detached')).toBe(true);
  });

  it('sets a title attribute only when provided', () => {
    const withTitle = render(() => <Orb state="idle" size={44} title="Agent: idle" />);
    expect(withTitle.container.querySelector('.orb')!.getAttribute('title')).toBe('Agent: idle');
    withTitle.unmount();

    const withoutTitle = render(() => <Orb state="idle" size={44} />);
    expect(withoutTitle.container.querySelector('.orb')!.hasAttribute('title')).toBe(false);
  });

  it.each(STATES)('renders every documented state with the matching orb--%s class', (state) => {
    const { container } = render(() => <Orb state={state} size={44} />);
    const root = container.querySelector('.orb')!;
    expect(root.classList.contains(`orb--${state}`)).toBe(true);
  });

  it('renders the full DOM shape: wobble > spin nucleus with nodes and edges, rings, and exit dots', () => {
    const { container } = render(() => <Orb state="running" size={104} />);
    const geometry = generateOrbGeometry(104);

    expect(container.querySelectorAll('.orb__w').length).toBe(1);
    expect(container.querySelectorAll('.orb__nw').length).toBe(1);
    expect(container.querySelectorAll('.orb__core').length).toBe(1);

    // Nucleus nesting: .orb__w > .orb__nw > .orb__core (contains edges/nodes).
    const wobble = container.querySelector('.orb__nw')!;
    expect(wobble.parentElement!.classList.contains('orb__w')).toBe(true);
    const core = container.querySelector('.orb__core')!;
    expect(core.parentElement).toBe(wobble);

    expect(container.querySelectorAll('.orb__e').length).toBe(geometry.edges.length);
    expect(container.querySelectorAll('.orb__n').length).toBe(geometry.nodes.length);
    expect(container.querySelectorAll('.orb__n--c').length).toBe(geometry.nodes.filter((n) => n.core).length);
    expect(container.querySelectorAll('.orb__ring').length).toBe(geometry.rings.length);
    expect(container.querySelectorAll('.orb__x').length).toBe(3);

    // Rings are siblings of the nucleus wrapper, not nested inside it.
    const ring = container.querySelector('.orb__ring')!;
    expect(ring.parentElement!.classList.contains('orb__w')).toBe(true);
  });

  it('gives each edge its tier class and a transform/length/delay style', () => {
    const { container } = render(() => <Orb state="idle" size={44} />);
    const edge = container.querySelector('.orb__e') as HTMLElement;
    expect(edge.className).toMatch(/orb__e orb__e--t[1-4]/);
    expect(edge.style.transform).toMatch(/^translate3d/);
    expect(edge.style.getPropertyValue('--l')).toMatch(/px$/);
    expect(edge.style.getPropertyValue('--dl')).toMatch(/s$/);
  });

  it('gives each ring an index modifier class, background, and direction custom property', () => {
    const { container } = render(() => <Orb state="idle" size={104} />);
    const rings = container.querySelectorAll('.orb__ring');
    expect(rings.length).toBeGreaterThan(0);
    rings.forEach((ring, i) => {
      expect(ring.classList.contains(`orb__ring--${i + 1}`)).toBe(true);
      const el = ring as HTMLElement;
      expect(el.style.background).toMatch(/^conic-gradient/);
      expect(['reverse', 'normal']).toContain(el.style.getPropertyValue('--dir'));
    });
  });

  it('recomputes geometry when size changes (node count follows orb.py _detail thresholds)', () => {
    const [size, setSize] = createSignal(18);
    const { container } = render(() => <Orb state="idle" size={size()} />);
    expect(container.querySelectorAll('.orb__n').length).toBe(generateOrbGeometry(18).nodes.length);

    setSize(104);
    expect(container.querySelectorAll('.orb__n').length).toBe(generateOrbGeometry(104).nodes.length);
    expect(generateOrbGeometry(104).nodes.length).not.toBe(generateOrbGeometry(18).nodes.length);
  });

  it('changing state alone does not rebuild the node/edge DOM (same element identity)', () => {
    const [state, setState] = createSignal<AgentOrbState>('idle');
    const { container } = render(() => <Orb state={state()} size={44} />);
    const nodeBefore = container.querySelector('.orb__n');
    const edgeBefore = container.querySelector('.orb__e');

    setState('running');

    const root = container.querySelector('.orb')!;
    expect(root.classList.contains('orb--running')).toBe(true);
    expect(container.querySelector('.orb__n')).toBe(nodeBefore);
    expect(container.querySelector('.orb__e')).toBe(edgeBefore);
  });
});
