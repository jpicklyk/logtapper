/**
 * Public API of the editor module (Principle 9 — import from here, never from an
 * internal file). `sanitizeSchema.ts` is internal: the schema it builds is
 * reached through `renderMarkdown`'s options.
 */

export { createTextEditor } from './createTextEditor';
export type { CreateTextEditorOptions, EditorMode, TextEditorHandle } from './createTextEditor';

export { Markdown } from './Markdown';
export type { MarkdownProps } from './Markdown';

export { renderMarkdown } from './renderMarkdown';
export type { RenderMarkdownOptions } from './renderMarkdown';

export { DEFAULT_SCHEMA } from './sanitizeSchema';
export type { SanitizeSchema } from './sanitizeSchema';

export {
  LINE_REF_CLASS,
  lineRefText,
  lineRefTitle,
  lineRefTargetFrom,
  rehypeLineRefs,
} from './lineRefs';
export type { LineRefOptions, LineRefSource, LineRefTarget } from './lineRefs';

export { EditorTab, basename, modeForPath } from './EditorTab';
export type { EditorTabProps } from './EditorTab';

export { AnalysisSectionView } from './AnalysisSectionView';
export type {
  AnalysisSectionViewProps,
  ResolvedReference,
  ResolvedSection,
} from './AnalysisSectionView';
