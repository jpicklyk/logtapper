import { Fragment } from 'react';
import type { PaneLayoutState } from '../hooks/usePaneLayout';
import TabBar from './TabBar';
import PaneContent from './PaneContent';
import DragHandle from './DragHandle';

interface Props {
  layout: PaneLayoutState;
  pipelineHasResults: boolean;
}

export default function PaneLayout({ layout, pipelineHasResults }: Props) {
  const { panes, preset, containerRef, resizePane } = layout;

  return (
    <div ref={containerRef} className={`pane-container pane-container--${preset}`}>
      {panes.map((pane, i) => (
        <Fragment key={pane.id}>
          {i > 0 && (
            <DragHandle
              onDrag={(delta) => {
                const w = containerRef.current?.getBoundingClientRect().width ?? 1;
                resizePane(panes[i - 1].id, delta / w);
              }}
            />
          )}
          <div className="pane" style={{ flex: pane.flexBasis }}>
            <TabBar
              pane={pane}
              paneIndex={i}
              paneCount={panes.length}
              layout={layout}
              pipelineHasResults={pipelineHasResults}
            />
            <div className="pane-content">
              <PaneContent pane={pane} />
            </div>
          </div>
        </Fragment>
      ))}
    </div>
  );
}
