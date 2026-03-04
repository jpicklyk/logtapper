import type { ReactNode } from 'react';

export interface GutterColumnDef {
  id: string;
  width: number;
  render: (lineNum: number) => ReactNode;
}
