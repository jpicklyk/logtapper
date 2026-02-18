// Types that mirror the Rust serde structs crossing the Tauri IPC boundary.
// Keep in sync with src-tauri/src/core/line.rs

export type LogLevel = 'Verbose' | 'Debug' | 'Info' | 'Warn' | 'Error' | 'Fatal';

export type HighlightKind =
  | { type: 'Search' }
  | { type: 'SearchActive' }
  | { type: 'ProcessorMatch'; id: string }
  | { type: 'ExtractedField'; name: string }
  | { type: 'PiiReplaced' };

export interface HighlightSpan {
  start: number;
  end: number;
  kind: HighlightKind;
}

export interface ViewLine {
  lineNum: number;
  raw: string;
  level: LogLevel;
  tag: string;
  message: string;
  timestamp: number;
  pid: number;
  tid: number;
  sourceId: string;
  highlights: HighlightSpan[];
  matchedBy: string[];
  isContext: boolean;
}

export interface LineWindow {
  totalLines: number;
  lines: ViewLine[];
}

export type ViewMode =
  | { mode: 'Full' }
  | { mode: 'Processor' }
  | { mode: 'Focus'; center: number };

export interface SearchQuery {
  text: string;
  isRegex: boolean;
  caseSensitive: boolean;
  withinProcessor?: string;
  minLevel?: LogLevel;
  tags?: string[];
}

export interface LineRequest {
  sessionId: string;
  mode: ViewMode;
  offset: number;
  count: number;
  context: number;
  processorId?: string;
  search?: SearchQuery;
}

export interface SearchSummary {
  totalMatches: number;
  matchLineNums: number[];
  byLevel: Record<string, number>;
  byTag: Record<string, number>;
}

export interface LoadResult {
  sessionId: string;
  sourceId: string;
  sourceName: string;
  totalLines: number;
  fileSize: number;
  firstTimestamp: number | null;
  lastTimestamp: number | null;
  sourceType: string;
}

// ---------------------------------------------------------------------------
// Processor types (Phase 2)
// ---------------------------------------------------------------------------

export interface ProcessorMeta {
  id: string;
  name: string;
  version: string;
  description: string;
  tags: string[];
}

export type VarType = 'int' | 'bool' | 'string' | 'float' | 'map' | 'list';

export interface VarDecl {
  name: string;
  type: VarType;
  default: unknown;
  display: boolean;
  label: string;
  displayAs?: 'table' | 'value';
  columns?: string[];
  configurable?: boolean;
}

export interface ProcessorSummary {
  id: string;
  name: string;
  version: string;
  description: string;
  tags: string[];
}

export interface PipelineRunSummary {
  processorId: string;
  matchedLines: number;
  emissionCount: number;
}

export interface PipelineProgress {
  processorId: string;
  linesProcessed: number;
  totalLines: number;
  percent: number;
}

// ---------------------------------------------------------------------------
// Chart types (Phase 3)
// ---------------------------------------------------------------------------

export interface DataPoint {
  x: number;
  y: number;
  label?: string;
  timelinePos?: number;
}

export interface DataSeries {
  label: string;
  color?: string;
  points: DataPoint[];
}

export interface ChartData {
  id: string;
  chartType: string;
  title: string;
  description?: string;
  series: DataSeries[];
  xAxis: { label: string; field: string };
  yAxis: { label: string };
}
