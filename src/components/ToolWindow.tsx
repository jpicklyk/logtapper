import { useAppContext } from '../context/AppContext';
import type { RightTool } from '../hooks/usePaneLayout';
import ProcessorPanel from './ProcessorPanel';
import ChatPanel from './ChatPanel';
import ProcessorMarketplace from './ProcessorMarketplace';

interface Props {
  tool: RightTool;
  width: number;
}

export default function ToolWindow({ tool, width }: Props) {
  const { viewer, pipeline, claude, processorViewId } = useAppContext();

  return (
    <div className="tool-window" style={{ width }}>
      {tool === 'processors' && (
        <ProcessorPanel
          pipeline={pipeline}
          sessionId={viewer.session?.sessionId ?? null}
          isStreaming={viewer.isStreaming}
        />
      )}
      {tool === 'chat' && (
        <ChatPanel
          claude={claude}
          sessionId={viewer.session?.sessionId ?? null}
          processorId={processorViewId}
        />
      )}
      {tool === 'marketplace' && (
        <ProcessorMarketplace pipeline={pipeline} />
      )}
    </div>
  );
}
