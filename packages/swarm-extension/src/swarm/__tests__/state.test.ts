import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { StateTracker } from "../state";

let tmpDir: string;

afterEach(async () => {
	if (tmpDir) {
		await fs.rm(tmpDir, { recursive: true, force: true });
	}
});

describe("StateTracker", () => {
	it("init creates directory structure", async () => {
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "swarm-state-test-"));

		const tracker = new StateTracker(tmpDir, "my-swarm");
		await tracker.init(["agent-a", "agent-b"], 1, "parallel");

		const stateDir = path.join(tracker.swarmDir, "state");
		const logsDir = path.join(tracker.swarmDir, "logs");

		const stateStat = await fs.stat(stateDir);
		expect(stateStat.isDirectory()).toBe(true);

		const logsStat = await fs.stat(logsDir);
		expect(logsStat.isDirectory()).toBe(true);
	});

	it("updateAgent persists agent data", async () => {
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "swarm-state-test-"));

		const tracker = new StateTracker(tmpDir, "my-swarm");
		await tracker.init(["agent-a"], 1, "parallel");

		await tracker.updateAgent("agent-a", { status: "running", iteration: 1 });

		const statePath = path.join(tracker.swarmDir, "state", "pipeline.json");
		const content = await fs.readFile(statePath, "utf8");
		const parsed = JSON.parse(content);

		expect(parsed.agents["agent-a"].status).toBe("running");
		expect(parsed.agents["agent-a"].iteration).toBe(1);
	});

	it("appendLog writes to log file", async () => {
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "swarm-state-test-"));

		const tracker = new StateTracker(tmpDir, "my-swarm");
		await tracker.init(["agent-x"], 1, "sequential");

		await tracker.appendLog("agent-x", "hello world");
		await tracker.appendLog("agent-x", "second line");

		const logPath = path.join(tracker.swarmDir, "logs", "agent-x.log");
		const content = await fs.readFile(logPath, "utf8");
		const lines = content.trim().split("\n");

		expect(lines.length).toBe(2);
		expect(lines[0]).toContain("hello world");
		expect(lines[1]).toContain("second line");
	});

	it("new StateTracker instance can load previously saved state", async () => {
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "swarm-state-test-"));

		const tracker = new StateTracker(tmpDir, "my-swarm");
		await tracker.init(["agent-a"], 1, "parallel");
		await tracker.updateAgent("agent-a", { status: "completed", iteration: 1 });
		const savedState = tracker.state;

		const tracker2 = new StateTracker(tmpDir, "my-swarm");
		const loaded = await tracker2.load();

		expect(loaded).not.toBeNull();
		expect(loaded!.name).toBe(savedState.name);
		expect(loaded!.status).toBe(savedState.status);
		expect(loaded!.agents["agent-a"].status).toBe("completed");
		expect(loaded!.agents["agent-a"].iteration).toBe(1);
	});
});
