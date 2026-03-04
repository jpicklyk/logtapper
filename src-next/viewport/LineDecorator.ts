import type { CSSProperties } from 'react';
import type { ViewLine } from '../bridge/types';

export interface LineDecoratorDef {
  classNames?: (line: ViewLine, isSelected: boolean, isJumpTarget: boolean) => string[];
  styles?: (line: ViewLine) => CSSProperties | undefined;
}
