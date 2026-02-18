import { Fragment } from 'react';
import type { PaneLayoutState } from '../hooks/usePaneLayout';
import TabBar from './TabBar';
import PaneContent from './PaneContent';
import DragHandle from './DragHandle';
import LeftSidebar from './LeftSidebar';
import ToolWindow from './ToolWindow';
import IconRail from './IconRail';

interface Props {
  layout: PaneLayoutState;
  pipelineHasResults: boolean;
}

export default function PaneLayout({ layout, pipelineHasResults }: Props) {
  const {
    panes,
    preset,
    containerRef,
    centerRef,
    resizePane,
    leftSidebarWidth,
    resizeLeftSidebar,
    rightTool,
    rightPanelWidth,
    toggleRightTool,
    resizeRightPanel,
  } = layout;

  const isCompact = preset === 'compact';

  return (
    <div ref={containerRef} className={`app-workspace app-workspace--${preset}`}>

      {/* ── Left sidebar — permanent navigation, no tabs ── */}
      {!isCompact && (
        <>
          <LeftSidebar width={leftSidebarWidth} />
          <DragHandle onDrag={resizeLeftSidebar} />
        </>
      )}

      {/* ── Center tabbed pane area ── */}
      <div ref={centerRef} className="pane-area">
        {panes.map((pane, i) => (
          <Fragment key={pane.id}>
            {i > 0 && (
              <DragHandle
                onDrag={(delta) => {
                  const w = centerRef.current?.getBoundingClientRect().width ?? 1;
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

      {/* ── Right tool window — collapsible via icon rail ── */}
      {!isCompact && rightTool !== null && (
        <>
          <DragHandle onDrag={resizeRightPanel} />
          <ToolWindow tool={rightTool} width={rightPanelWidth} />
        </>
      )}

      {/* ── Icon rail — far right edge ── */}
      {!isCompact && (
        <IconRail activeTool={rightTool} onToggle={toggleRightTool} />
      )}

    </div>
  );
}
