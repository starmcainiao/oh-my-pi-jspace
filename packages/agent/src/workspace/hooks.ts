/**
 * Workspace Bus — hook helpers for agent loop integration.
 *
 * These functions bridge the workspace bus into the agent loop's hook points:
 * - `makePostToolHook` — extracts facts from tool results and writes to workspace
 * - `makePreToolPrompt` — reads relevant workspace entries for prompt injection
 * - `makeTransformContext` — transforms agent context to include workspace state
 * - `extractIntentFromArgs` — reads the `i` (intent) field from tool args
 */

import type { AgentToolResult } from "../types";
import { formatWorkspaceForPrompt, type WorkspaceBus } from "./bus";
import type { WorkspaceSlotKind } from "./slot";

/**
 * Heuristic extractor: turn a tool result into workspace entries.
 *
 * Returns an array of {key, value, kind, importance} tuples to be written.
 * Override via `customExtractor` for domain-specific extraction.
 */
export interface ToolResultExtraction {
	key: string;
	value: unknown;
	kind?: WorkspaceSlotKind;
	importance?: number;
	ttl?: number;
}

export type ToolResultExtractor = (
	toolName: string,
	result: AgentToolResult<unknown>,
	args: Record<string, unknown>,
) => ToolResultExtraction[];

/**
 * Default extractor for common omp tools.
 */
export function defaultToolResultExtractor(
	toolName: string,
	result: AgentToolResult<unknown>,
	args: Record<string, unknown>,
): ToolResultExtraction[] {
	const extractions: ToolResultExtraction[] = [];

	switch (toolName) {
		case "read": {
			const path = String(args.path ?? "");
			if (path) {
				const textBlock = result.content.find((c) => c.type === "text") as { text?: string } | undefined;
				const summary = textBlock?.text ? summarizeText(textBlock.text) : "(empty)";
				extractions.push({
					key: `read:${path}`,
					value: { path, summary, lines: textBlock?.text?.split("\n").length ?? 0 },
					kind: "fact",
					importance: 0.7,
					ttl: 3,
				});
			}
			break;
		}

		case "edit": {
			const path = String(args.path ?? args.input?.path ?? "");
			if (path) {
				extractions.push({
					key: `edit:${path}`,
					value: { path, intent: args.i ?? "(unknown)" },
					kind: "fact",
					importance: 0.8,
					ttl: 2,
				});
			}
			break;
		}

		case "bash": {
			const exitCode = result.isError ? 1 : 0;
			const textBlock = result.content.find((c) => c.type === "text") as { text?: string } | undefined;
			const summary = textBlock?.text ? summarizeText(textBlock.text, 100) : "(no output)";
			extractions.push({
				key: exitCode === 0 ? "bash:ok" : "bash:error",
				value: { exitCode, command: args.command ?? "", summary },
				kind: exitCode === 0 ? "fact" : "error",
				importance: exitCode === 0 ? 0.5 : 0.9,
				ttl: exitCode === 0 ? 2 : 4,
			});
			break;
		}

		case "grep": {
			const pattern = String(args.pattern ?? "");
			if (pattern) {
				const text = result.content.find((c) => c.type === "text") as { text?: string } | undefined;
				const matchCount = text?.text ? (text.text.match(/\n/g)?.length ?? 0) + 1 : 0;
				extractions.push({
					key: `grep:${pattern}`,
					value: { pattern, matchCount },
					kind: "fact",
					importance: 0.6,
					ttl: 2,
				});
			}
			break;
		}

		case "web_search": {
			const query = String(args.query ?? "");
			if (query) {
				extractions.push({
					key: `search:${query}`,
					value: { query },
					kind: "fact",
					importance: 0.6,
					ttl: 3,
				});
			}
			break;
		}

		case "glob":
		case "task": {
			const intent = String(args.i ?? args.intent ?? args.description ?? "");
			if (intent) {
				extractions.push({
					key: `${toolName}:${intent.slice(0, 40)}`,
					value: { intent: intent.slice(0, 100) },
					kind: "fact",
					importance: 0.5,
					ttl: 2,
				});
			}
			break;
		}
	}

	// Always track the intent field if present
	if (args.i && typeof args.i === "string" && args.i.length > 3) {
		extractions.push({
			key: `intent:${toolName}`,
			value: args.i,
			kind: "intent",
			importance: 0.7,
			ttl: 2,
		});
	}

	return extractions;
}

/**
 * Create a post-tool-call hook that writes extracted info to the workspace.
 */
export function makePostToolHook(
	bus: WorkspaceBus,
	extractor: ToolResultExtractor = defaultToolResultExtractor,
): (toolName: string, result: AgentToolResult<unknown>, args: Record<string, unknown>) => void {
	return (toolName, result, args) => {
		const entries = extractor(toolName, result, args);
		for (const e of entries) {
			if (e.key) {
				bus.write(e.key, e.value, `tool:${toolName}`, e.kind ?? "fact", {
					importance: e.importance,
					ttl: e.ttl,
				});
			}
		}
	};
}

/**
 * Read relevant workspace entries for a given tool call, returning
 * prompt-ready text snippets.
 */
export function getRelevantWorkspaceContext(
	bus: WorkspaceBus,
	toolName: string,
	args: Record<string, unknown>,
	maxEntries = 5,
): string {
	// Collect context from workspace
	const entries: string[] = [];

	// Tool-specific lookups
	switch (toolName) {
		case "read":
		case "edit": {
			// Get info about this file
			const path = String(args.path ?? args.input?.path ?? "");
			if (path) {
				const prevRead = bus.read(`read:${path}`);
				if (prevRead) entries.push(`previous read of ${path}: ${JSON.stringify(prevRead.value)}`);
				const prevEdit = bus.read(`edit:${path}`);
				if (prevEdit) entries.push(`last edit to ${path}: ${JSON.stringify(prevEdit.value)}`);
			}
			const errors = bus.queryKind("error");
			if (errors.length > 0) {
				entries.push(`recent errors: ${errors.map((e) => `${e.key}=${JSON.stringify(e.value)}`).join(" | ")}`);
			}
			break;
		}

		case "bash": {
			const lastOk = bus.read("bash:ok");
			const lastErr = bus.read("bash:error");
			if (lastErr) entries.push(`last command error: ${JSON.stringify(lastErr.value)}`);
			if (lastOk) entries.push(`last successful command: ${JSON.stringify(lastOk.value).slice(0, 80)}`);
			break;
		}

		case "grep": {
			// If grep query is related to a read path
			const pattern = String(args.pattern ?? "");
			if (pattern) {
				const extant = bus.query(`grep:${pattern}`);
				if (extant.length > 0) entries.push(`previous grep results: ${JSON.stringify(extant[0].value)}`);
			}
			break;
		}
	}

	// Add top-K general context
	const topSlots = bus.getTopK(maxEntries);
	if (topSlots.length > 0) {
		entries.push(formatWorkspaceForPrompt(topSlots, "Workspace Context"));
	}

	return entries.join("\n");
}

/**
 * Generate a compact workspace summary for prompt injection (transformContext hook).
 */
export function makeWorkspaceContextInjector(bus: WorkspaceBus, maxSlots = 8): () => string {
	return () => {
		const top = bus.getTopK(maxSlots);
		if (top.length === 0) return "";
		return formatWorkspaceForPrompt(top);
	};
}

// ─── Helpers ──────────────────────────────────────────────────

function summarizeText(text: string, maxLen = 120): string {
	const cleaned = text.replace(/\s+/g, " ").trim();
	if (cleaned.length <= maxLen) return cleaned;
	return cleaned.slice(0, maxLen) + "...";
}
