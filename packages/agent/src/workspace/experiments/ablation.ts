/**
 * Ablation Experiment (Exp 2) — bandwidth constraint experiment.
 *
 * Replicates the J-space ablation finding: removing the workspace should
 * degrade multi-step reasoning while leaving simple tasks intact.
 *
 * Protocol:
 * 1. Define a set of benchmark tasks, classified as "simple" or "multi-step".
 * 2. Run each task under multiple workspace configurations:
 *    - CONTROL: unlimited workspace (K=32)
 *    - ABLATED_K4: workspace limited to 4 slots
 *    - ABLATED_K8: workspace limited to 8 slots  
 *    - ABLATED_ZERO: workspace completely disabled (K=0)
 * 3. Measure: task completion, tool call accuracy, tokens, turns, errors.
 *
 * This module provides the measurement types and the result collector.
 * The actual task runner depends on the harness (see experiments/ directory).
 */

import { WorkspaceBus } from "../bus";

// ─── Task taxonomy ─────────────────────────────────────────

export type TaskComplexity = "simple" | "multi_step" | "creative";

export interface BenchmarkTask {
	id: string;
	description: string;
	prompt: string;
	complexity: TaskComplexity;
	/** Expected tool call sequence (partial order). */
	expectedToolSequence?: string[];
	/** Ground-truth answer for automated scoring. */
	expectedAnswer?: string;
}

// ─── Experiment config ─────────────────────────────────────

export type AblationConfig =
	| { mode: "control" }
	| { mode: "ablated"; keepK: number }
	| { mode: "zero" };

export const ABLATION_CONFIGS: AblationConfig[] = [
	{ mode: "control" },
	{ mode: "ablated", keepK: 8 },
	{ mode: "ablated", keepK: 4 },
	{ mode: "zero" },
];

export function applyAblationConfig(bus: WorkspaceBus, config: AblationConfig): void {
	switch (config.mode) {
		case "control":
			bus.disableAblation();
			break;
		case "ablated":
			bus.setAblation(config.keepK);
			break;
		case "zero":
			bus.setAblation(0);
			break;
	}
}

// ─── Measurement types ─────────────────────────────────────

export interface ToolCallRecord {
	toolName: string;
	intent: string;
	timestamp: number;
	success: boolean;
	durationMs: number;
}

export interface TurnRecord {
	turnNumber: number;
	modelCallTokens: number;
	toolCalls: ToolCallRecord[];
	workspaceSnapshot: number; // size at turn boundary
}

export interface TaskResult {
	taskId: string;
	config: AblationConfig;
	completed: boolean;
	correct: boolean | null; // null when no ground truth available
	turns: TurnRecord[];
	totalTokens: number;
	totalDurationMs: number;
	errorCount: number;
	/** Free-form notes from the observer. */
	notes?: string;
}

export interface AblationExperimentResult {
	experimentDate: string;
	configLabel: string;
	config: AblationConfig;
	tasks: TaskResult[];
	aggregate: {
		totalTasks: number;
		completedTasks: number;
		correctTasks: number;
		avgTokens: number;
		avgTurns: number;
		avgErrorRate: number;
		/** Breakdown by complexity */
		byComplexity: Record<
			TaskComplexity,
			{
				total: number;
				completed: number;
				correct: number;
				avgTurns: number;
			}
		>;
	};
}

// ─── Result aggregation ────────────────────────────────────

export function aggregateAblationResults(
	configLabel: string,
	config: AblationConfig,
	tasks: TaskResult[],
): AblationExperimentResult {
	const byComplexity: AblationExperimentResult["aggregate"]["byComplexity"] = {
		simple: { total: 0, completed: 0, correct: 0, avgTurns: 0 },
		multi_step: { total: 0, completed: 0, correct: 0, avgTurns: 0 },
		creative: { total: 0, completed: 0, correct: 0, avgTurns: 0 },
	};

	for (const t of tasks) {
		// We don't have complexity info on TaskResult directly, so we reconstruct
		// from taskId naming convention or later from the benchmark spec
	}

	const completed = tasks.filter((t) => t.completed);
	const correct = completed.filter((t) => t.correct === true);

	const totalTokens = tasks.reduce((s, t) => s + t.totalTokens, 0);
	const totalTurns = tasks.reduce((s, t) => s + t.turns.length, 0);
	const totalErrors = tasks.reduce((s, t) => s + t.errorCount, 0);

	return {
		experimentDate: new Date().toISOString(),
		configLabel,
		config,
		tasks,
		aggregate: {
			totalTasks: tasks.length,
			completedTasks: completed.length,
			correctTasks: correct.length,
			avgTokens: tasks.length > 0 ? totalTokens / tasks.length : 0,
			avgTurns: tasks.length > 0 ? totalTurns / tasks.length : 0,
			avgErrorRate: tasks.length > 0 ? totalErrors / tasks.length : 0,
			byComplexity,
		},
	};
}

// ─── Default benchmark tasks ───────────────────────────────

export function getDefaultBenchmarkTasks(): BenchmarkTask[] {
	return [
		// Simple tasks (single tool call, routine)
		{
			id: "simple_read",
			description: "Read a file and summarize its contents",
			prompt: "Read the file README.md and tell me what the project is about in one sentence.",
			complexity: "simple",
			expectedToolSequence: ["read"],
		},
		{
			id: "simple_grep",
			description: "Search for a pattern in codebase",
			prompt: "Find all TypeScript files that import from 'react'.",
			complexity: "simple",
			expectedToolSequence: ["grep", "glob"],
		},
		{
			id: "simple_bash",
			description: "Run a shell command",
			prompt: "How many lines of Rust code are in the crates/pi-natives directory?",
			complexity: "simple",
			expectedToolSequence: ["bash"],
		},

		// Multi-step tasks (require chaining tools, intermediate reasoning)
		{
			id: "multi_find_edit",
			description: "Find a function and edit it",
			prompt:
				"Find the function that calculates token counts in the codebase. Rename it to 'countTokens' and update all callers.",
			complexity: "multi_step",
			expectedToolSequence: ["grep", "read", "grep", "edit"],
		},
		{
			id: "multi_debug",
			description: "Debug a build error step by step",
			prompt:
				"The TypeScript build is failing with an error about missing type exports. Find the error, locate the missing export, and add it.",
			complexity: "multi_step",
			expectedToolSequence: ["bash", "read", "edit"],
		},
		{
			id: "multi_research",
			description: "Research and synthesize information",
			prompt:
				"Search for the latest version of the 'tree-sitter' crate on crates.io, check if our Cargo.toml is up to date, and if not, update it.",
			complexity: "multi_step",
			expectedToolSequence: ["web_search", "read", "edit"],
		},

		// Creative tasks (require workspace for planning)
		{
			id: "creative_refactor",
			description: "Plan and execute a refactor",
			prompt:
				"The file src/utils/helpers.ts has several duplicate utility functions. Identify the duplicates, consolidate them, and update all imports.",
			complexity: "creative",
			expectedToolSequence: ["read", "grep", "read", "edit", "grep", "edit"],
		},
	];
}
