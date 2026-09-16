import type { ViewLine } from '../bridge/types';

export interface DataSource {
  readonly totalLines: number;
  readonly sourceId: string;
  getLine(lineNum: number): ViewLine | undefined;
  getLines(offset: number, count: number): ViewLine[] | Promise<ViewLine[]>;
  onAppend?: (cb: (newLines: ViewLine[], totalLines: number) => void) => () => void;
  notifyVisible?: (firstLine: number, lastLine: number) => void;
  /** Update total line count externally (e.g. streaming batches). Optional — only CacheDataSource implements this. */
  updateTotalLines?: (n: number) => void;
  /** Clean up internal resources. Optional — only CacheDataSource implements this. */
  dispose?: () => void;
}
