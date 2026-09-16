/**
 * Public API of the workspace module (principle 9).
 *
 * The pure rules behind opening, restoring and reconciling a `.ltw` workspace:
 * what the app-state payload contains, how a workspace list is reconciled with
 * disk, what a restore plan looks like, how artifacts pair back onto sessions,
 * whether a saved session is still trustworthy, and how an extra `.lts` import
 * joins an open workspace. No frontend state, no framework.
 */
export * from './appStatePayload';
export * from './reconcileWorkspaceList';
export * from './restorePlan';
export * from './artifactPairing';
export * from './startupFile';
export * from './restoreTrust';
export * from './multiSessionImport';
