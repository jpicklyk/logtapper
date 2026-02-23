import { useAppContext } from '../context/AppContext';
import type { RightTool } from '../hooks/usePaneLayout';
import ProcessorPanel from './ProcessorPanel';
import ProcessorMarketplace from './ProcessorMarketplace';

interface Props {
  tool: RightTool;
  width: number;
}

export default function ToolWindow({ tool, width }: Props) {
  const { viewer, pipeline, onOpenLibrary } = useAppContext();

  return (
    <div className="tool-window" style={{ width }}>
      {tool === 'processors' && (
        <ProcessorPanel
          pipeline={pipeline}
          sessionId={viewer.session?.sessionId ?? null}
          isStreaming={viewer.isStreaming}
          onOpenLibrary={onOpenLibrary}
          cacheSize={viewer.streamCache.size}
          cacheMax={viewer.streamBufferMax}
        />
      )}
      {tool === 'marketplace' && (
        <ProcessorMarketplace pipeline={pipeline} />
      )}
    </div>
  );
}
