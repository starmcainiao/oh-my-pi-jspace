/**
 * Tests for eviction strategies.
 */
import { describe, it, expect } from "bun:test";
import { findExpired, pickVictim, truncateTo } from "../eviction";
import type { WorkspaceSlot } from "../slot";

function makeSlot(overrides: Partial<WorkspaceSlot>): WorkspaceSlot {
	return {
		key: "k",
		value: "v",
		source: "test",
		kind: "fact",
		timestamp: 0,
		turnCreated: 0,
		ttl: 0,
		importance: 0.5,
		readCount: 0,
		lastReadTurn: 0,
		...overrides,
	};
}

describe("eviction", () => {
	it("findExpired: ttl=3 turnCreated=1 at turn=5 — expired. ttl=0 — not expired", () => {
		const expiredSlot = makeSlot({ ttl: 3, turnCreated: 1 });
		const eternalSlot = makeSlot({ ttl: 0, turnCreated: 1 });
		const result = findExpired([expiredSlot, eternalSlot], 5);
		expect(result).toHaveLength(1);
		expect(result[0]).toBe(expiredSlot);
	});

	it("pickVictim lru: lowest lastReadTurn wins", () => {
		const slots: WorkspaceSlot[] = [
			makeSlot({ key: "old", lastReadTurn: 2 }),
			makeSlot({ key: "recent", lastReadTurn: 10 }),
			makeSlot({ key: "oldest", lastReadTurn: 1 }),
		];
		const idx = pickVictim(slots, 10, "lru");
		expect(idx).toBeGreaterThanOrEqual(0);
		expect(slots[idx].key).toBe("oldest");
	});

	it("pickVictim lru_importance: weighted scoring", () => {
		const slots: WorkspaceSlot[] = [
			makeSlot({ key: "recent-but-low-imp", lastReadTurn: 9, importance: 0.1 }),
			makeSlot({ key: "old-but-some-imp", lastReadTurn: 1, importance: 0.5 }),
			makeSlot({ key: "middle", lastReadTurn: 5, importance: 0.2 }),
		];
		const idx = pickVictim(slots, 10, "lru_importance");
		expect(idx).toBeGreaterThanOrEqual(0);
		// The lowest-scoring slot should be "old-but-some-imp" because:
		//   recencyNorm of old=0.1, score=0.1*0.7+0.5*0.3=0.07+0.15=0.22
		//   recencyNorm of recent=0.9, score=0.9*0.7+0.1*0.3=0.63+0.03=0.66
		//   recencyNorm of middle=0.5, score=0.5*0.7+0.2*0.3=0.35+0.06=0.41
		expect(slots[idx].key).toBe("old-but-some-imp");
	});

	it("truncateTo: 5→2, kept have higher importance than evicted", () => {
		const slots: WorkspaceSlot[] = [
			makeSlot({ key: "a", importance: 0.1 }),
			makeSlot({ key: "b", importance: 0.9 }),
			makeSlot({ key: "c", importance: 0.3 }),
			makeSlot({ key: "d", importance: 0.7 }),
			makeSlot({ key: "e", importance: 0.5 }),
		];
		const { kept, evicted } = truncateTo(slots, 2, 1, "importance");
		expect(kept).toHaveLength(2);
		expect(evicted).toHaveLength(3);
		// Kept should be b (0.9) and d (0.7)
		for (const k of kept) {
			for (const e of evicted) {
				expect(k.importance).toBeGreaterThan(e.importance);
			}
		}
	});
});
