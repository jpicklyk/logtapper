/** Public API of `src-solid/packs/`: the remote marketplace half (browse,
 *  install/uninstall, update detection) plus the panel that presents it.
 *  Outside code imports from this barrel only. */
export { createPacksStore } from './packsStore';
export type { PacksStore, PacksStoreDeps, PacksCommands, UpdateAllOutcome } from './packsStore';

export { PacksPanel } from './PacksPanel';
export type { PacksPanelProps } from './PacksPanel';

export { UpdatesPrompt } from './UpdatesPrompt';
export type { UpdatesPromptProps } from './UpdatesPrompt';
