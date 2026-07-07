/**
 * Tests for the Workspace Bus.
 */
import { describe, it, expect } from "bun:test";
import { WorkspaceBus } from "../bus";

describe("WorkspaceBus", () => {
	it("write + read — value matches, readCount=1", () => {
		const bus = new WorkspaceBus({ capacity: 8 });
		bus.write("key-a", { data: 42 }, "test");
		const slot = bus.read("key-a");
		expect(slot).toBeDefined();
		expect(slot!.key).toBe("key-a");
		expect(slot!.value).toEqual({ data: 42 });
		expect(slot!.readCount).toBe(1);
		expect(slot!.source).toBe("test");
	});

	it("re-write same key — size unchanged, TTL reset, old readCount preserved", () => {
		const bus = new WorkspaceBus({ capacity: 8 });
		bus.write("key-a", "first", "test", "fact", { ttl: 5 });
		// Read once so readCount becomes 1
		bus.read("key-a");
		// Re-write
		bus.write("key-a", "second", "other");
		expect(bus.size).toBe(1);
		const slot = bus.read("key-a");
		expect(slot!.value).toBe("second");
		expect(slot!.readCount).toBe(2); // 1 from before + 1 from this read
	});

	it("readValue — returns T or undefined", () => {
		const bus = new WorkspaceBus({ capacity: 8 });
		bus.write("key-a", 99, "test");
		expect(bus.readValue<number>("key-a")).toBe(99);
		expect(bus.readValue("missing-key")).toBeUndefined();
	});

	it("remove — returns true, read returns undefined, evict event fires", () => {
		const bus = new WorkspaceBus({ capacity: 8 });
		bus.write("key-a", "value", "test");
		const events: string[] = [];
		bus.onChange((e) => {
			if (e.type === "evict") events.push(e.type + ":" + (e.reason ?? ""));
		});
		const removed = bus.remove("key-a");
		expect(removed).toBe(true);
		expect(bus.read("key-a")).toBeUndefined();
		expect(events).toContain("evict:explicit");
	});

	it("clear — size=0, clear event fires", () => {
		const bus = new WorkspaceBus({ capacity: 8 });
		bus.write("key-a", "a", "test");
		bus.write("key-b", "b", "test");
		const events: string[] = [];
		bus.onChange((e) => {
			if (e.type === "clear") events.push("clear");
		});
		bus.clear();
		expect(bus.size).toBe(0);
		expect(events).toContain("clear");
	});

	it("write capacity+1 keys — size <= capacity", () => {
		const bus = new WorkspaceBus({ capacity: 3 });
		bus.write("a", 1, "test");
		bus.write("b", 2, "test");
		bus.write("c", 3, "test");
		expect(bus.size).toBe(3);
		// This write should evict one
		bus.write("d", 4, "test");
		expect(bus.size).toBeLessThanOrEqual(3);
	});

	it("lru strategy — recently read key not evicted", () => {
		const bus = new WorkspaceBus({ capacity: 2, strategy: "lru" });
		bus.write("a", 1, "test");
		bus.write("b", 2, "test");
		// Advance turn so read bumps lastReadTurn
		bus.advanceTurn();
		// Read "a" — makes it more recent than "b"
		bus.read("a");
		// This write should evict "b" (least recently used — lastReadTurn=0)
		bus.write("c", 3, "test");
		expect(bus.read("a")).toBeDefined();
		expect(bus.read("b")).toBeUndefined();
		expect(bus.read("c")).toBeDefined();
	});

	it("fifo strategy — earliest written key evicted first", () => {
		const bus = new WorkspaceBus({ capacity: 2, strategy: "fifo" });
		bus.write("a", 1, "test");
		bus.write("b", 2, "test");
		// Read "a" — should not help under FIFO
		bus.read("a");
		bus.write("c", 3, "test");
		expect(bus.read("a")).toBeUndefined();
		expect(bus.read("b")).toBeDefined();
	});

	it("importance strategy — lowest importance evicted", () => {
		const bus = new WorkspaceBus({ capacity: 2, strategy: "importance" });
		bus.write("a", 1, "test", "fact", { importance: 0.9 });
		bus.write("b", 2, "test", "fact", { importance: 0.1 });
		bus.write("c", 3, "test", "fact", { importance: 0.5 });
		expect(bus.read("b")).toBeUndefined();
		expect(bus.read("a")).toBeDefined();
		expect(bus.read("c")).toBeDefined();
	});

	it("ttl=1, advanceTurn() twice — slot gone", () => {
		const bus = new WorkspaceBus({ capacity: 8 });
		bus.write("key-a", "value", "test", "fact", { ttl: 1 });
		expect(bus.read("key-a")).toBeDefined();
		bus.advanceTurn(); // turn=1 → expires: 1-0 >= 1
		bus.advanceTurn(); // turn=2
		expect(bus.read("key-a")).toBeUndefined();
	});

	it("ttl=0 never evicted", () => {
		const bus = new WorkspaceBus({ capacity: 8 });
		bus.write("eternal", "stays", "test", "fact", { ttl: 0 });
		for (let i = 0; i < 20; i++) bus.advanceTurn();
		expect(bus.read("eternal")).toBeDefined();
	});

	it("setAblation(2) with 3 slots — size <= 2", () => {
		const bus = new WorkspaceBus({ capacity: 8 });
		bus.write("a", 1, "test");
		bus.write("b", 2, "test");
		bus.write("c", 3, "test");
		expect(bus.size).toBe(3);
		bus.setAblation(2);
		expect(bus.size).toBeLessThanOrEqual(2);
	});

	it("setAblation(0) — write throws Error", () => {
		const bus = new WorkspaceBus({ capacity: 8 });
		bus.write("a", 1, "test");
		bus.setAblation(0);
		expect(bus.size).toBe(0);
		expect(() => bus.write("b", 2, "test")).toThrow(
			"WorkspaceBus: capacity is zero (ablation to empty)",
		);
	});

	it("disableAblation() — normal capacity restored", () => {
		const bus = new WorkspaceBus({ capacity: 8 });
		bus.write("a", 1, "test");
		bus.write("b", 2, "test");
		bus.write("c", 3, "test");
		bus.setAblation(2);
		expect(bus.size).toBeLessThanOrEqual(2);
		expect(bus.limit).toBe(2);
		bus.disableAblation();
		expect(bus.limit).toBe(8);
		// Can write more up to original cap
		bus.write("d", 4, "test");
		bus.write("e", 5, "test");
		bus.write("f", 6, "test");
		bus.write("g", 7, "test");
		bus.write("h", 8, "test");
		expect(bus.size).toBeLessThanOrEqual(8);
	});

	it("onChange fires for write events", () => {
		const bus = new WorkspaceBus({ capacity: 8 });
		const events: string[] = [];
		bus.onChange((e) => {
			if (e.type === "write") events.push("write:" + (e.slot?.key ?? "?"));
		});
		bus.write("key-a", "val", "test");
		expect(events).toEqual(["write:key-a"]);
	});

	it("onChange unsubscribe works", () => {
		const bus = new WorkspaceBus({ capacity: 8 });
		const events: string[] = [];
		const unsub = bus.onChange((e) => {
			events.push(e.type);
		});
		bus.write("a", 1, "test");
		expect(events).toEqual(["write"]);
		unsub();
		bus.write("b", 2, "test");
		// Event count unchanged
		expect(events).toEqual(["write"]);
	});

	it("getTopK(2) returns highest importance in order", () => {
		const bus = new WorkspaceBus({ capacity: 8 });
		bus.write("low", "v", "test", "fact", { importance: 0.1 });
		bus.write("high", "v", "test", "fact", { importance: 0.9 });
		bus.write("mid", "v", "test", "fact", { importance: 0.5 });
		const top = bus.getTopK(2);
		expect(top).toHaveLength(2);
		expect(top[0].key).toBe("high");
		expect(top[1].key).toBe("mid");
	});

	it("query / queryKind work", () => {
		const bus = new WorkspaceBus({ capacity: 8 });
		bus.write("current-file", "file.ts", "test", "fact");
		bus.write("intent-fix", "fix bug", "test", "intent");
		bus.write("last-error", "err", "test", "error");
		bus.write("another-fact", "info", "test", "fact");

		const queried = bus.query("intent");
		expect(queried).toHaveLength(1);
		expect(queried[0].key).toBe("intent-fix");

		const errors = bus.queryKind("error");
		expect(errors).toHaveLength(1);
		expect(errors[0].key).toBe("last-error");

		const facts = bus.queryKind("fact");
		expect(facts).toHaveLength(2);
	});
});
