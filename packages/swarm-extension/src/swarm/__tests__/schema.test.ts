import { describe, expect, it } from "bun:test";
import { parseSwarmYaml, validateSwarmDefinition } from "../schema";
import type { SwarmDefinition } from "../schema";

describe("parseSwarmYaml", () => {
	it("parses minimal valid YAML with default mode", () => {
		const yaml = `
swarm:
  name: test-swarm
  workspace: /tmp
  agents:
    researcher:
      role: researcher
      task: research topic
    writer:
      role: writer
      task: write output
`;
		const def = parseSwarmYaml(yaml);

		expect(def.name).toBe("test-swarm");
		expect(def.mode).toBe("sequential");
		expect(def.agents.size).toBe(2);
		expect(def.agentOrder).toEqual(["researcher", "writer"]);
	});

	it("throws when name is missing", () => {
		const yaml = `
swarm:
  workspace: /tmp
  agents:
    a:
      role: r
      task: t
`;
		expect(() => parseSwarmYaml(yaml)).toThrow(/name/i);
	});

	it("throws when top-level 'swarm' key is missing", () => {
		const yaml = `
name: orphan
workspace: /tmp
agents:
  a:
    role: r
    task: t
`;
		expect(() => parseSwarmYaml(yaml)).toThrow(/swarm/);
	});

	it("accepts mode=parallel and mode=pipeline, rejects invalid mode", () => {
		const parallelYaml = `
swarm:
  name: p
  workspace: /tmp
  mode: parallel
  agents:
    a:
      role: r
      task: t
`;
		const parallelDef = parseSwarmYaml(parallelYaml);
		expect(parallelDef.mode).toBe("parallel");

		const pipelineYaml = `
swarm:
  name: p
  workspace: /tmp
  mode: pipeline
  agents:
    a:
      role: r
      task: t
`;
		const pipelineDef = parseSwarmYaml(pipelineYaml);
		expect(pipelineDef.mode).toBe("pipeline");

		const invalidYaml = `
swarm:
  name: p
  workspace: /tmp
  mode: invalid-mode
  agents:
    a:
      role: r
      task: t
`;
		expect(() => parseSwarmYaml(invalidYaml)).toThrow(/invalid-mode/);
	});

	it("parses waits_for correctly", () => {
		const yaml = `
swarm:
  name: test
  workspace: /tmp
  agents:
    a:
      role: r
      task: t
    b:
      role: r
      task: t
      waits_for:
        - a
`;
		const def = parseSwarmYaml(yaml);
		expect(def.agents.get("a")!.waitsFor).toEqual([]);
		expect(def.agents.get("b")!.waitsFor).toEqual(["a"]);
	});
});

describe("validateSwarmDefinition", () => {
	it("catches nonexistent agent reference in waits_for", () => {
		const def: SwarmDefinition = {
			name: "test",
			workspace: "/tmp",
			mode: "parallel",
			targetCount: 1,
			agents: new Map([
				["a", { name: "a", role: "r", task: "t", reportsTo: [], waitsFor: ["nonexistent"] }],
			]),
			agentOrder: ["a"],
		};

		const errors = validateSwarmDefinition(def);
		expect(errors.length).toBeGreaterThan(0);
		expect(errors.some(e => e.includes("nonexistent"))).toBe(true);
	});

	it("catches self-referencing waits_for", () => {
		const def: SwarmDefinition = {
			name: "test",
			workspace: "/tmp",
			mode: "parallel",
			targetCount: 1,
			agents: new Map([
				["a", { name: "a", role: "r", task: "t", reportsTo: [], waitsFor: ["a"] }],
			]),
			agentOrder: ["a"],
		};

		const errors = validateSwarmDefinition(def);
		expect(errors.length).toBeGreaterThan(0);
		expect(errors.some(e => e.includes("cannot wait for itself"))).toBe(true);
	});
});
