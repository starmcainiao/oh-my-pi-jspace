/**
 * Slot types for the J-space Workspace Bus.
 *
 * Each slot in the workspace represents one "concept" the agent is actively
 * holding in its global workspace — analogous to a J-space entry in Claude.
 */

export type WorkspaceSlotKind = "fact" | "intent" | "intermediate" | "error";

/**
 * A single slot in the workspace bus.
 *
 * @template T — runtime type of `value`; not checked, purely documentary.
 */
export interface WorkspaceSlot<T = unknown> {
	/** Short identifier, e.g. "current_file", "last_error", "intent:fix_bug". */
	readonly key: string;
	/** Any JSON-serializable value. */
	value: T;
	/** Component that wrote it, e.g. "read", "bash", "subagent:fe", "user". */
	source: string;
	/** Classification — influences eviction and prompt-injection priority. */
	kind: WorkspaceSlotKind;
	/** Monotonic write timestamp (performance.now() or turn counter). */
	timestamp: number;
	/** Agent turn number when this slot was created / last overwritten. */
	turnCreated: number;
	/** Turns before auto-evict. 0 = eternal. */
	ttl: number;
	/** 0.0–1.0 — used for eviction ordering and prompt injection priority. */
	importance: number;
	/** How many times this slot has been read. */
	readCount: number;
	/** Last turn number when this slot was read. */
	lastReadTurn: number;
}

export function createSlot<T>(
	key: string,
	value: T,
	source: string,
	kind: WorkspaceSlotKind = "fact",
	options?: {
		ttl?: number;
		importance?: number;
		currentTurn?: number;
	},
): WorkspaceSlot<T> {
	const now = typeof performance !== "undefined" ? performance.now() : Date.now();
	return {
		key,
		value,
		source,
		kind,
		timestamp: now,
		turnCreated: options?.currentTurn ?? 0,
		ttl: options?.ttl ?? 0,
		importance: options?.importance ?? 0.5,
		readCount: 0,
		lastReadTurn: 0,
	};
}

/**
 * A change event emitted when the workspace bus mutates.
 */
export interface WorkspaceChangeEvent {
	type: "write" | "evict" | "clear" | "ablate";
	slot?: WorkspaceSlot;
	evicted?: WorkspaceSlot[];
	/** Reason for eviction — "ttl" | "lru" | "importance" | "capacity" | "explicit". */
	reason?: string;
	timestamp: number;
}
