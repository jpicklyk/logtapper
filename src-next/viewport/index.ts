// Interfaces
export type { DataSource } from './DataSource';
export type { GutterColumnDef } from './GutterColumn';
export type { LineDecoratorDef } from './LineDecorator';
export type { Selection } from './SelectionManager';

// Hooks
export { useSelectionManager } from './SelectionManager';

// Components
export { default as ReadOnlyViewer } from './ReadOnlyViewer';
export { default as TextLine, TextLineSkeleton } from './TextLine';

// Data sources
export { createCacheDataSource } from './CacheDataSource';
export type { CacheDataSource } from './CacheDataSource';
export type { StreamPusher, DataSourceRegistrar } from './DataSourceRegistry';
