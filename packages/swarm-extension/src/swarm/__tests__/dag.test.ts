import { describe, expect, it } from "bun:test";
import { buildDependencyGraph, detectCycles, buildExecutionWaves } from "../dag";
import type { SwarmDefinition } from "../schema";

function makeDef(
	overrides: Partial<SwarmDefinition> & {
		agents: Array<{ name: string; waitsFor?: string[]; reportsTo?: string[] }>;
	},
): SwarmDefinition {
	const agentOrder = overrides.agents.map(a => a.name);
	const agents = new Map(
		overrides.agents.map(a => [
			a.name,
			{
				name: a.name,
				role: "r",
				task: "t",
				reportsTo: a.reportsTo ?? [],
				waitsFor: a.waitsFor ?? [],
			},
		]),
	);
	return {
		name: "test",
		workspace: "/tmp",
		mode: "parallel",
		targetCount: 1,
		...overrides,
		agentOrder,
		agents,
	};
}

describe("buildExecutionWaves", () => {
	it("parallel mode: no waits_for puts all agents in wave 0", () => {
		const def = makeDef({
			mode: "parallel",
			agents: [{ name: "a" }, { name: "b" }, { name: "c" }],
		});
		const deps = buildDependencyGraph(def);
		const waves = buildExecutionWaves(deps);
		expect(waves).toEqual([["a", "b", "c"]]);
	});

	it("sequential mode auto-chains 3 agents into 3 waves", () => {
		const def = makeDef({
			mode: "sequential",
			agents: [{ name: "a" }, { name: "b" }, { name: "c" }],
		});
		const deps = buildDependencyGraph(def);
		const waves = buildExecutionWaves(deps);
		expect(waves).toEqual([["a"], ["b"], ["c"]]);
	});

	it("explicit dependency places b and c in same wave after a", () => {
		const def = makeDef({
			mode: "parallel",
			agents: [
				{ name: "a" },
				{ name: "b", waitsFor: ["a"] },
				{ name: "c", waitsFor: ["a"] },
			],
		});
		const deps = buildDependencyGraph(def);
		const waves = buildExecutionWaves(deps);
		expect(waves).toEqual([["a"], ["b", "c"]]);
	});
});

describe("detectCycles", () => {
	it("returns null for acyclic graph", () => {
		const deps = new Map<string, Set<string>>([
			["a", new Set()],
			["b", new Set(["a"])],
			["c", new Set(["b"])],
		]);
		expect(detectCycles(deps)).toBeNull();
	});

	it("returns cycle participants for a->b->a", () => {
		const deps = new Map<string, Set<string>>([
			["a", new Set(["b"])],
			["b", new Set(["a"])],
		]);
		const result = detectCycles(deps);
		expect(result).not.toBeNull();
		expect(result).toEqual(expect.arrayContaining(["a", "b"]));
	});
});
