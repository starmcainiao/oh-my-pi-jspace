export { WorkspaceBus, formatWorkspaceForPrompt } from "./bus";
export type { WorkspaceBusOptions, WorkspaceChangeCallback } from "./bus";
export type { WorkspaceSlot, WorkspaceSlotKind, WorkspaceChangeEvent } from "./slot";
export { createSlot } from "./slot";
export {
	defaultToolResultExtractor,
	makePostToolHook,
	getRelevantWorkspaceContext,
	makeWorkspaceContextInjector,
} from "./hooks";
export type { ToolResultExtraction, ToolResultExtractor } from "./hooks";
export {
	withWorkspaceConfig,
	wrapToolWithWorkspace,
	verifyWorkspaceBus,
} from "./plugin";
export type { WorkspacePluginConfig } from "./plugin";
