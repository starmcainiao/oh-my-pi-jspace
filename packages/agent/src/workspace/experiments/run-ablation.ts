#!/usr/bin/env bun
/**
 * Bandwidth Ablation Runner (Exp 2)
 *
 * Runs benchmark tasks under multiple workspace configurations and
 * measures the effect on task completion, tool accuracy, and tokens.
 *
 * Prerequisites:
 * - Full omp build (`bun setup && bun run build:native`)
 * - LLM provider API key configured in `~/.omp/auth/`
 *
 * Usage:
 *   bun run packages/agent/src/workspace/experiments/run-ablation.ts
 *   bun run packages/agent/src/workspace/experiments/run-ablation.ts --tasks simple_read,multi_debug
 *   bun run packages/agent/src/workspace/experiments/run-ablation.ts --configs control,k8,zero
 *
 * Output:
 *   ./ablation-results/  — JSON results per config + aggregate
 */

import { getDefaultBenchmarkTasks, aggregateAblationResults, type AblationConfig, type AblationExperimentResult, type TaskResult, ABLATION_CONFIGS } from "./ablation";
import { WorkspaceBus } from "../bus";

// Parse args
const args = process.argv.slice(2);
const taskFilter = args.includes("--tasks") ? args[args.indexOf("--tasks") + 1]?.split(",") : null;
const configFilter = args.includes("--configs") ? args[args.indexOf("--configs") + 1]?.split(",") : null;

const allTasks = getDefaultBenchmarkTasks();
const tasks = taskFilter ? allTasks.filter((t) => taskFilter.includes(t.id)) : allTasks;
const configs = configFilter
	? ABLATION_CONFIGS.filter((c) => configFilter.includes(labelForConfig(c)))
	: ABLATION_CONFIGS;

console.log(`[ablation] Tasks: ${tasks.map((t) => t.id).join(", ")}`);
console.log(`[ablation] Configs: ${configs.map(labelForConfig).join(", ")}`);

for (const config of configs) {
	console.log(`\n=== Config: ${labelForConfig(config)} ===`);

	const bus = new WorkspaceBus({ capacity: 32 });
	applyAblationConfig(bus, config);
	console.log(`  Capacity: ${bus.limit}, Occupancy: ${bus.size}/${bus.limit}`);

	const taskResults: TaskResult[] = [];

	for (const task of tasks) {
		console.log(`  Task: ${task.id} (${task.complexity})`);

		const result: TaskResult = {
			taskId: task.id,
			config,
			completed: false,
			correct: null,
			turns: [],
			totalTokens: 0,
			totalDurationMs: 0,
			errorCount: 0,
		};

		/// TODO: Wire actual agent loop here
		///   const agent = createAgentWithWorkspace(bus, config);
		///   const output = await agent.run(task.prompt);
		///   result.completed = output.completed;
		///   result.correct = scoreOutput(output, task.expectedAnswer);
		///   result.turns = output.turns;
		///   result.totalTokens = output.tokens;
		///   result.errorCount = output.errors;
		///
		/// For now, we record the config for a dry run:
		result.notes = `DRY RUN — requires agent loop with workspace config: capacity=${bus.limit}, ablation=${bus.isAblationEnabled()}`;

		taskResults.push(result);
	}

	const aggregated = aggregateAblationResults(labelForConfig(config), config, taskResults);
	saveResults(aggregated);
}

console.log("\n=== Ablation experiment complete ===");
console.log(`Results saved to ./ablation-results/`);

// ─── Helpers ──────────────────────────────────────────────

function labelForConfig(config: AblationConfig): string {
	switch (config.mode) {
		case "control": return "control";
		case "ablated": return `k${config.keepK}`;
		case "zero": return "zero";
	}
}

function applyAblationConfig(bus: WorkspaceBus, config: AblationConfig): void {
	switch (config.mode) {
		case "control": bus.disableAblation(); break;
		case "ablated": bus.setAblation(config.keepK); break;
		case "zero": bus.setAblation(0); break;
	}
}

function saveResults(result: AblationExperimentResult): void {
	const fs = require("node:fs") as typeof import("node:fs");
	const dir = "./ablation-results";
	fs.mkdirSync(dir, { recursive: true });
	const file = `${dir}/${result.configLabel}.json`;
	fs.writeFileSync(file, JSON.stringify(result, null, 2));
}
