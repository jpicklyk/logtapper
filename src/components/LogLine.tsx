import { memo } from 'react';
import type { ViewLine } from '../bridge/types';
import HighlightedText from './HighlightedText';

interface Props {
  line: ViewLine;
  style: React.CSSProperties;
  onClick?: (lineNum: number) => void;
}

const LEVEL_CLASS: Record<string, string> = {
  Verbose: 'level-v',
  Debug: 'level-d',
  Info: 'level-i',
  Warn: 'level-w',
  Error: 'level-e',
  Fatal: 'level-f',
};

const LEVEL_CHAR: Record<string, string> = {
  Verbose: 'V',
  Debug: 'D',
  Info: 'I',
  Warn: 'W',
  Error: 'E',
  Fatal: 'F',
};

function formatTimestamp(ns: number): string {
  if (ns === 0) return '            '; // 12 spaces — keeps columns aligned
  // ns is relative to 2000-01-01, extract HH:MM:SS.mmm portion
  const totalMs = Math.floor(ns / 1_000_000);
  const ms = totalMs % 1000;
  const totalSec = Math.floor(totalMs / 1000);
  const sec = totalSec % 60;
  const totalMin = Math.floor(totalSec / 60);
  const min = totalMin % 60;
  const hour = Math.floor(totalMin / 60) % 24;
  return `${String(hour).padStart(2, '0')}:${String(min).padStart(2, '0')}:${String(sec).padStart(2, '0')}.${String(ms).padStart(3, '0')}`;
}

const LogLine = memo(function LogLine({ line, style, onClick }: Props) {
  const levelClass = LEVEL_CLASS[line.level] ?? 'level-i';
  const levelChar = LEVEL_CHAR[line.level] ?? '?';

  return (
    <div
      className={`log-line ${levelClass} ${line.isContext ? 'context-line' : ''}`}
      style={style}
      onClick={() => onClick?.(line.lineNum)}
      title={`Line ${line.lineNum + 1} | PID ${line.pid} | TID ${line.tid}`}
    >
      <span className="log-linenum">{String(line.lineNum + 1).padStart(7, ' ')}</span>
      <span className="log-ts">{formatTimestamp(line.timestamp)}</span>
      <span className={`log-level ${levelClass}`}>{levelChar}</span>
      <span className="log-tag" title={line.tag}>
        {line.tag.slice(0, 23).padEnd(23, ' ')}
      </span>
      <span className="log-msg">
        <HighlightedText text={line.message || line.raw} highlights={line.highlights} />
      </span>
    </div>
  );
});

export default LogLine;
