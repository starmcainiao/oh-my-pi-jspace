#!/usr/bin/env bun
/**
 * Reportability Experiment Runner (Exp 5)
 *
 * Tests whether the agent can accurately report its workspace contents.
 * Injects a "report your workspace" prompt at random midpoints and
 * compares the agent's self-report against the actual workspace state.
 *
 * Prerequisites:
 * - Full omp build (`bun setup && bun run build:native`)
 * - LLM provider API key configured
 *
 * Usage:
 *   bun run packages/agent/src/workspace/experiments/run-reportability.ts
 *   bun run packages/agent/src/workspace/experiments/run-reportability.ts --tasks multi_debug --probes 3
 *
 * Output:
 *   ./reportability-results/  — JSON per-task + aggregate
 */

import { scoreProbe, aggregateReportability, generateProbePrompt, extractConcepts, type ReportabilityProbe, type ReportabilityResult } from "../experiments/reportability";
import type { WorkspaceSlot } from "../slot";

const args = process.argv.slice(2);
const taskFilter = args.includes("--tasks") ? args[args.indexOf("--tasks") + 1]?.split(",") : null;
const probeCount = args.includes("--probes") ? parseInt(args[args.indexOf("--probes") + 1], 10) : 3;

const probePrompts = [
	generateProbePrompt("freeform"),
	generateProbePrompt("structured"),
];

console.log(`[reportability] Probes per task: ${probeCount}`);
console.log(`[reportability] Probe formats: ${probePrompts.length}`);

// ─── Benchmark tasks for reportability ────────────────────

interface ReportabilityTask {
	id: string;
	prompt: string;
	description: string;
}

const reportabilityTasks: ReportabilityTask[] = [
	{
		id: "multi_debug",
		description: "Debug a build error step by step",
		prompt: "The TypeScript build is failing with an error about missing type exports. Find the error, locate the missing export, and add it.",
	},
	{
		id: "multi_refactor",
		description: "Find and rename a function across the codebase",
		prompt: "Find the function `formatBytes` across the codebase, rename it to `formatFileSize`, and update all callers.",
	},
];

const tasks = taskFilter
	? reportabilityTasks.filter((t) => taskFilter.includes(t.id))
	: reportabilityTasks;

console.log(`[reportability] Tasks: ${tasks.map((t) => t.id).join(", ")}`);

// ─── Run experiments ──────────────────────────────────────

const allResults: ReportabilityResult[] = [];

for (const task of tasks) {
	console.log(`\n=== Task: ${task.id} ===`);

	const probes: ReportabilityProbe[] = [];

	for (let p = 0; p < probeCount; p++) {
		const promptIdx = p % probePrompts.length;
		console.log(`  Probe ${p + 1}/${probeCount} (format: ${promptIdx === 0 ? "freeform" : "structured"})`);

		/// TODO: Wire actual agent execution here
		///   1. Start agent with workspace bus
		///   2. Wait for a few turns
		///   3. Snapshot workspace
		///   4. Inject probe prompt
		///   5. Collect report
		///   6. Continue task
		///
		/// For now, synthetic test:

		const fakeSlot: WorkspaceSlot = {
			key: `test:${task.id}`,
			value: `testing ${task.id}`,
			source: "user",
			kind: "fact",
			timestamp: Date.now(),
			turnCreated: p * 2,
			ttl: 0,
			importance: 0.5,
			readCount: 1,
			lastReadTurn: p * 2 + 1,
		};

		const workspaceSnapshot = [fakeSlot];
		const agentReport = `${task.description} — currently focused on finding the error. Task: ${task.prompt.slice(0, 50)}...`;
		const extractedConcepts = extractConcepts(agentReport);

		const probe: ReportabilityProbe = {
			turnNumber: p * 2,
			probePrompt: probePrompts[0],
			agentReport,
			workspaceSnapshot,
			extractedConcepts,
		};

		// Score this probe
		const score = scoreProbe(probe);
		console.log(`    Precision: ${score.precision.toFixed(2)}, Recall: ${score.recall.toFixed(2)}, F1: ${score.f1.toFixed(2)}`);
		console.log(`    Hallucinated: ${score.hallucinated.length}, Matched: ${score.matched.length}`);

		probes.push(probe);
	}

	const result: ReportabilityResult = {
		taskId: task.id,
		probes,
		aggregate: {
			totalProbes: probes.length,
			avgPrecision: probes.reduce((s, p) => s + scoreProbe(p).precision, 0) / probes.length,
			avgRecall: probes.reduce((s, p) => s + scoreProbe(p).recall, 0) / probes.length,
			avgF1: probes.reduce((s, p) => s + scoreProbe(p).f1, 0) / probes.length,
			hallucinationRate: probes.reduce((s, p) => s + scoreProbe(p).hallucinated.length, 0) / probes.length,
			predictionAccuracy: 0,
		},
	};

	console.log(`\n  Aggregate: F1=${result.aggregate.avgF1.toFixed(2)}, Precision=${result.aggregate.avgPrecision.toFixed(2)}, Recall=${result.aggregate.avgRecall.toFixed(2)}`);

	allResults.push(result);
	saveResult(result);
}

// ─── Summary ──────────────────────────────────────────────

const overall = aggregateReportability(allResults);
console.log(`\n=== Overall Reportability ===`);
console.log(`Total probes: ${overall.aggregate.totalProbes}`);
console.log(`Avg F1:       ${overall.aggregate.avgF1.toFixed(3)}`);
console.log(`Precision:    ${overall.aggregate.avgPrecision.toFixed(3)}`);
console.log(`Recall:       ${overall.aggregate.avgRecall.toFixed(3)}`);
console.log(`Hallucination:${overall.aggregate.hallucinationRate.toFixed(2)}/probe`);
console.log(`Prediction:   ${(overall.aggregate.predictionAccuracy * 100).toFixed(0)}%`);
console.log(`\nResults saved to ./reportability-results/`);

function saveResult(result: ReportabilityResult): void {
	const fs = require("node:fs") as typeof import("node:fs");
	const dir = "./reportability-results";
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(`${dir}/${result.taskId}.json`, JSON.stringify(result, null, 2));
}
