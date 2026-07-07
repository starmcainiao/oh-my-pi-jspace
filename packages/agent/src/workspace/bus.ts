/**
 * Workspace Bus — J-space analog for agent orchestration.
 *
 * A fixed-capacity shared memory that all agent components (tools, subagents,
 * stream rules) can read from and write to. It serves as the "global
 * workspace" — the privileged channel for deliberate reasoning, analogous to
 * J-space in Claude's neural network.
 *
 * Key invariants:
 * - Capacity is fixed at construction time (K slots).
 * - Entries auto-evict by LRU + importance when capacity is exceeded.
 * - TTL-expired entries are evicted eagerly.
 * - Writes to an existing key *replace* the slot (reset TTL, bump timestamp).
 */

import { pickVictim, findExpired, truncateTo } from "./eviction";
import { createSlot, type WorkspaceChangeEvent, type WorkspaceSlot, type WorkspaceSlotKind } from "./slot";

export type { WorkspaceSlot, WorkspaceSlotKind, WorkspaceChangeEvent };

export interface WorkspaceBusOptions {
	/** Maximum number of slots (default 16). */
	capacity?: number;
	/** Eviction strategy (default "lru_importance"). */
	strategy?: "lru" | "fifo" | "importance" | "lru_importance";
}

export type WorkspaceChangeCallback = (event: WorkspaceChangeEvent) => void;

/**
 * Default prompt-injection format for the top-K workspace entries.
 * Returns a short text block suitable for appending to the model's context.
 */
export function formatWorkspaceForPrompt(slots: WorkspaceSlot[], title = "Workspace"): string {
	if (slots.length === 0) return "";

	const lines = slots.map((s) => {
		const val =
			typeof s.value === "string"
				? s.value.slice(0, 200)
				: typeof s.value === "object" && s.value !== null
					? JSON.stringify(s.value).slice(0, 200)
					: String(s.value).slice(0, 200);
		return `  [${s.kind}] ${s.key} ← ${s.source}: ${val}`;
	});

	return `[${title} — ${slots.length} slot(s)]\n${lines.join("\n")}\n`;
}

export class WorkspaceBus {
	private slots: Map<string, WorkspaceSlot> = new Map();
	private readonly capacity: number;
	private readonly strategy: NonNullable<WorkspaceBusOptions["strategy"]>;
	private turnCounter = 0;
	private readonly listeners: Set<WorkspaceChangeCallback> = new Set();
	private _ablationEnabled = false;
	private _ablateKeepK = 0;
	private writeCount = 0;

	constructor(options: WorkspaceBusOptions = {}) {
		this.capacity = options.capacity ?? 16;
		this.strategy = options.strategy ?? "lru_importance";
	}

	// ─── Configuration ───────────────────────────────────────────

	getCapacity(): number {
		if (this._ablationEnabled) return Math.min(this.capacity, this._ablateKeepK);
		return this.capacity;
	}

	/** Enable ablation mode: cap effective capacity at K. */
	setAblation(keepK: number): void {
		if (keepK <= 0) {
			this._ablationEnabled = true;
			this._ablateKeepK = 0;
			this.slots.clear();
			return;
		}
		if (keepK >= this.capacity) {
			this._ablationEnabled = false;
			return;
		}
		this._ablationEnabled = true;
		this._ablateKeepK = keepK;
		// Enforce immediately
		const { evicted } = truncateTo([...this.slots.values()], keepK, this.turnCounter, this.strategy);
		for (const s of evicted) this.slots.delete(s.key);
		if (evicted.length > 0) {
			this.emit({ type: "ablate", evicted, timestamp: now() });
		}
	}

	disableAblation(): void {
		this._ablationEnabled = false;
	}

	isAblationEnabled(): boolean {
		return this._ablationEnabled;
	}

	getEffectiveCapacity(): number {
		return this.getCapacity();
	}

	advanceTurn(): void {
		this.turnCounter++;
		// Eager TTL eviction
		const expired = findExpired([...this.slots.values()], this.turnCounter);
		for (const s of expired) this.slots.delete(s.key);
		if (expired.length > 0) {
			this.emit({ type: "evict", evicted: expired, reason: "ttl", timestamp: now() });
		}
	}

	getCurrentTurn(): number {
		return this.turnCounter;
	}

	getWriteCount(): number {
		return this.writeCount;
	}

	// ─── Subscribe ───────────────────────────────────────────────

	onChange(cb: WorkspaceChangeCallback): () => void {
		this.listeners.add(cb);
		return () => this.listeners.delete(cb);
	}

	// ─── Core operations ─────────────────────────────────────────

	/**
	 * Write a value to the workspace. If the key already exists, the slot is
	 * replaced (TTL reset, timestamp bumped). Otherwise evicts if at capacity.
	 */
	write<T>(
		key: string,
		value: T,
		source: string,
		kind: WorkspaceSlotKind = "fact",
		options?: { ttl?: number; importance?: number },
	): WorkspaceSlot<T> {
		const existing = this.slots.get(key);
		if (existing) {
			// Replace existing slot
			const updated = createSlot(key, value, source, kind, {
				...options,
				currentTurn: this.turnCounter,
			});
			// Preserve read stats
			updated.readCount = existing.readCount;
			updated.lastReadTurn = existing.lastReadTurn;
			this.slots.set(key, updated);
			this.writeCount++;
			this.emit({ type: "write", slot: updated, timestamp: now() });
			return updated;
		}

		// New entry — evict if at capacity
		const effectiveCap = this.getCapacity();
		if (effectiveCap <= 0) throw new Error("WorkspaceBus: capacity is zero (ablation to empty)");

		if (this.slots.size >= effectiveCap) {
			const slotArr = [...this.slots.values()];
			const victimIdx = pickVictim(slotArr, this.turnCounter, this.strategy);
			if (victimIdx >= 0) {
				const victim = slotArr[victimIdx];
				this.slots.delete(victim.key);
				this.emit({ type: "evict", evicted: [victim], reason: "capacity", timestamp: now() });
			}
		}

		const slot = createSlot(key, value, source, kind, {
			...options,
			currentTurn: this.turnCounter,
		});
		this.slots.set(key, slot);
		this.writeCount++;
		this.emit({ type: "write", slot, timestamp: now() });
		return slot;
	}

	/**
	 * Read a value by key. Returns the slot or undefined if not found.
	 * Bumps recency stats.
	 */
	read(key: string): WorkspaceSlot | undefined {
		const slot = this.slots.get(key);
		if (!slot) return undefined;
		slot.readCount++;
		slot.lastReadTurn = this.turnCounter;
		return slot;
	}

	/**
	 * Read just the value (convenience).
	 */
	readValue<T = unknown>(key: string): T | undefined {
		return this.slots.get(key)?.value as T | undefined;
	}

	/**
	 * Search slots by key prefix (substring match).
	 */
	query(prefix: string): WorkspaceSlot[] {
		const lower = prefix.toLowerCase();
		const results: WorkspaceSlot[] = [];
		for (const slot of this.slots.values()) {
			if (slot.key.toLowerCase().includes(lower)) {
				results.push(slot);
			}
		}
		return results;
	}

	/**
	 * Search by kind.
	 */
	queryKind(kind: WorkspaceSlotKind): WorkspaceSlot[] {
		const results: WorkspaceSlot[] = [];
		for (const slot of this.slots.values()) {
			if (slot.kind === kind) results.push(slot);
		}
		return results;
	}

	/**
	 * Get the N highest-importance slots (for prompt injection).
	 */
	getTopK(k: number): WorkspaceSlot[] {
		const sorted = [...this.slots.values()].sort((a, b) => {
			// Prefer higher importance, then more recently read
			const imp = b.importance - a.importance;
			if (imp !== 0) return imp;
			return b.lastReadTurn - a.lastReadTurn;
		});
		return sorted.slice(0, Math.min(k, sorted.length));
	}

	/**
	 * Remove a specific key from the workspace.
	 */
	remove(key: string): boolean {
		const slot = this.slots.get(key);
		if (!slot) return false;
		this.slots.delete(key);
		this.emit({ type: "evict", evicted: [slot], reason: "explicit", timestamp: now() });
		return true;
	}

	/**
	 * Clear all slots.
	 */
	clear(): void {
		const evicted = [...this.slots.values()];
		this.slots.clear();
		this.turnCounter = 0;
		if (evicted.length > 0) {
			this.emit({ type: "clear", evicted, timestamp: now() });
		}
	}

	/**
	 * Snapshot the entire workspace (for experiments / reportability).
	 */
	snapshot(): WorkspaceSlot[] {
		return [...this.slots.values()].map((s) => ({ ...s }));
	}

	/** Number of occupied slots. */
	get size(): number {
		return this.slots.size;
	}

	/** Total capacity (may be reduced by ablation). */
	get limit(): number {
		return this.getCapacity();
	}

	// ─── Internals ───────────────────────────────────────────────

	private emit(event: WorkspaceChangeEvent): void {
		for (const cb of this.listeners) {
			try {
				cb(event);
			} catch {
				// Listener must not crash the bus
			}
		}
	}
}

function now(): number {
	return typeof performance !== "undefined" ? performance.now() : Date.now();
}
