/** @jsxImportSource solid-js */
import { For, createMemo } from 'solid-js';
import type { JSX } from 'solid-js';
import { generateOrbGeometry, orbColorToken } from './orbGeometry';
import type { AgentOrbState } from './agentState';
import './orb.css';

export interface OrbProps {
  state: AgentOrbState;
  /** Diameter in px. Rails/top bar use 18-28, panel headers 44-56, the expanded presence panel 96+. */
  size: number;
  title?: string;
}

/**
 * Renders `orbGeometry.ts`'s generated network (Fibonacci shell + core,
 * nearest-neighbour edges, broken rings) — see `design_docs/canvas/orb.py`
 * and `AgentOrb.dc.html` for the design rationale.
 *
 * Geometry is memoized on `size` alone, so a state change (the common case —
 * the same orb cycling detached → idle → reading → ...) only swaps the
 * `orb--{state}` class and the `--orb-c` colour token; no DOM is rebuilt.
 * Only a `size` change re-derives the node/edge/ring layout.
 */
export function Orb(props: OrbProps): JSX.Element {
  const geometry = createMemo(() => generateOrbGeometry(props.size));

  const rootStyle = (): JSX.CSSProperties =>
    ({
      '--orb-size': `${props.size}px`,
      '--orb-dot': `${geometry().dot}px`,
      '--orb-line': `${geometry().line}px`,
      '--orb-c': orbColorToken(props.state),
    }) as JSX.CSSProperties;

  return (
    <div class={`orb orb--${props.state}`} style={rootStyle()} title={props.title}>
      <div class="orb__w">
        <div class="orb__nw">
          <div class="orb__core">
            <For each={geometry().edges}>
              {(edge) => (
                <i
                  class={`orb__e orb__e--t${edge.tier}`}
                  style={
                    {
                      '--l': `${edge.lengthPx.toFixed(1)}px`,
                      '--dl': `${edge.delaySec.toFixed(2)}s`,
                      transform: edge.transform,
                    } as JSX.CSSProperties
                  }
                />
              )}
            </For>
            <For each={geometry().nodes}>
              {(node) => (
                <b
                  class={node.core ? 'orb__n orb__n--c' : 'orb__n'}
                  style={
                    {
                      '--dl': `${node.delaySec.toFixed(2)}s`,
                      transform: `translate3d(${node.x.toFixed(1)}px, ${node.y.toFixed(1)}px, ${node.z.toFixed(1)}px)`,
                    } as JSX.CSSProperties
                  }
                />
              )}
            </For>
          </div>
        </div>
        <For each={geometry().rings}>
          {(ring) => (
            <s
              class={`orb__ring orb__ring--${ring.index}`}
              style={
                {
                  '--rw': `${ring.widthPercent.toFixed(0)}%`,
                  '--rt': `${ring.thicknessPx.toFixed(1)}px`,
                  '--t': `${ring.periodSec.toFixed(0)}s`,
                  '--dl': `${ring.delaySec.toFixed(1)}s`,
                  '--dir': ring.reverse ? 'reverse' : 'normal',
                  background: ring.background,
                } as JSX.CSSProperties
              }
            />
          )}
        </For>
      </div>
      <For each={geometry().exits}>
        {(exit) => (
          <u
            class="orb__x"
            style={
              {
                '--ex': exit.dx,
                '--ey': exit.dy,
                '--dl': `${exit.delaySec.toFixed(2)}s`,
              } as JSX.CSSProperties
            }
          />
        )}
      </For>
    </div>
  );
}
