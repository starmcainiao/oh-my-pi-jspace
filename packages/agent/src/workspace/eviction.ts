/**
 * Eviction strategies for the workspace bus.
 *
 * J-space has finite capacity (~dozens of concepts). These strategies
 * govern what gets evicted when the bus is full.
 *
 * Primary: LRU (least recently used)
 * Secondary: lowest importance
 * Always: TTL-expired slots first
 */

import type { WorkspaceSlot } from "./slot";

export type EvictionStrategy = "lru" | "fifo" | "importance" | "lru_importance";

/**
 * Score a slot for eviction — lower score = more likely to be evicted.
 */
function scoreSlot(slot: WorkspaceSlot, strategy: EvictionStrategy, currentTurn: number): number {
	switch (strategy) {
		case "lru":
			// Higher lastReadTurn = more recent = keep. Lower = evict.
			return slot.lastReadTurn;

		case "fifo":
			// Higher turnCreated = newer = keep. Lower = evict.
			return slot.turnCreated;

		case "importance":
			// Higher importance = keep.
			return slot.importance;

		case "lru_importance": {
			// Weighted: 70% recency, 30% importance.
			const recencyNorm = Math.min(slot.lastReadTurn / Math.max(currentTurn, 1), 1);
			return recencyNorm * 0.7 + slot.importance * 0.3;
		}
	}
}

/**
 * Find slots that have exceeded their TTL.
 */
export function findExpired(slots: WorkspaceSlot[], currentTurn: number): WorkspaceSlot[] {
	return slots.filter((s) => s.ttl > 0 && currentTurn - s.turnCreated >= s.ttl);
}

/**
 * Pick a victim slot to evict from a full workspace.
 * Returns the slot index to evict, or -1 if no evictable slot found.
 */
export function pickVictim(
	slots: WorkspaceSlot[],
	currentTurn: number,
	strategy: EvictionStrategy = "lru_importance",
): number {
	if (slots.length === 0) return -1;

	let worstIdx = 0;
	let worstScore = scoreSlot(slots[0], strategy, currentTurn);

	for (let i = 1; i < slots.length; i++) {
		const s = scoreSlot(slots[i], strategy, currentTurn);
		if (s < worstScore) {
			worstScore = s;
			worstIdx = i;
		}
	}

	return worstIdx;
}

/**
 * Truncate to keep only top-K entries by score.
 * Returns evicted slots.
 */
export function truncateTo(
	slots: WorkspaceSlot[],
	keepK: number,
	currentTurn: number,
	strategy: EvictionStrategy = "lru_importance",
): { kept: WorkspaceSlot[]; evicted: WorkspaceSlot[] } {
	if (slots.length <= keepK) return { kept: [...slots], evicted: [] };

	const sorted = [...slots].sort(
		(a, b) => scoreSlot(b, strategy, currentTurn) - scoreSlot(a, strategy, currentTurn),
	);

	return {
		kept: sorted.slice(0, keepK),
		evicted: sorted.slice(keepK),
	};
}
