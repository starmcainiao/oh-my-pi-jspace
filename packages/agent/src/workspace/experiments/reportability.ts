/**
 * Reportability Experiment (Exp 5) — can the agent report its workspace?
 *
 * Replicates the J-space reportability finding: the model can describe what's
 * in its J-space when asked, and the report causally reflects its actual
 * internal state.
 *
 * Protocol:
 * 1. Run multi-step agent tasks.
 * 2. At a random midpoint, inject a "report your current workspace" prompt.
 * 3. Collect the agent's verbal report.
 * 4. At the same moment, take a workspace bus snapshot.
 * 5. Compare: precision/recall of claimed vs actual workspace contents.
 * 6. Correlate: does the report predict the next tool call?
 *
 * Measurements:
 * - Precision: fraction of claimed concepts that are actually in workspace
 * - Recall: fraction of actual workspace concepts that are claimed
 * - Predictive power: does the reported "next intent" match the actual next tool call?
 * - Hallucination rate: concepts claimed but NOT in workspace
 */

import type { WorkspaceSlot } from "../slot";

// ─── Probe types ───────────────────────────────────────────

export interface ReportabilityProbe {
	/** Turn number at which the probe was injected. */
	turnNumber: number;
	/** The prompt injected to elicit the report. */
	probePrompt: string;
	/** The agent's raw textual report. */
	agentReport: string;
	/** Workspace snapshot taken at the same moment. */
	workspaceSnapshot: WorkspaceSlot[];
	/** Concepts extracted from the agent's report. */
	extractedConcepts: string[];
	/** The actual next tool call after the probe response. */
	nextToolCall?: { toolName: string; intent: string };
}

export interface ReportabilityResult {
	taskId: string;
	probes: ReportabilityProbe[];
	aggregate: {
		totalProbes: number;
		avgPrecision: number;
		avgRecall: number;
		avgF1: number;
		hallucinationRate: number;
		predictionAccuracy: number; // how often reported intent matches next tool
	};
}

// ─── Concept extraction ────────────────────────────────────

/**
 * Simple keyword-based concept extraction from a text report.
 * In production this would use a lightweight NLP approach.
 */
export function extractConcepts(report: string): string[] {
	const words = report
		.toLowerCase()
		.replace(/[^a-z0-9_\-/\s]/g, " ")
		.split(/\s+/)
		.filter((w) => w.length > 2);

	// Skip common stopwords and meta-descriptors
	const stopwords = new Set([
		"the", "and", "for", "that", "this", "with", "from", "have",
		"been", "being", "was", "are", "has", "had", "but", "not",
		"what", "which", "their", "them", "would", "could", "about",
		"there", "into", "over", "also", "than", "then", "very",
		"just", "think", "working", "trying", "currently", "looking",
		"right", "going", "need", "some", "can", "will", "been",
		"workspace", "report", "currently",
	]);

	return [...new Set(words.filter((w) => !stopwords.has(w)))];
}

/**
 * Extract key-value pairs from agent report (e.g. "current file: src/foo.ts").
 */
export function extractKeyValues(report: string): Map<string, string> {
	const map = new Map<string, string>();
	// Match patterns like "key: value" or "key = value"
	const pattern = /(\w[\w\s/._-]+?)\s*[:=]\s*(.+?)(?:\n|$)/g;
	let match: RegExpExecArray | null;
	while ((match = pattern.exec(report)) !== null) {
		const key = match[1].trim().toLowerCase().replace(/\s+/g, "_");
		const value = match[2].trim();
		if (key && value && key.length < 50 && value.length < 200) {
			map.set(key, value);
		}
	}
	return map;
}

// ─── Scoring ───────────────────────────────────────────────

export interface ScoreResult {
	precision: number;
	recall: number;
	f1: number;
	hallucinated: string[];
	matched: string[];
	missed: string[];
}

/**
 * Score a single probe: compare extracted concepts against workspace keys + values.
 */
export function scoreProbe(probe: ReportabilityProbe): ScoreResult {
	const workspaceKeys = new Set<string>();
	for (const slot of probe.workspaceSnapshot) {
		// Add key tokens
		for (const part of slot.key.split(/[:/]/)) {
			if (part.length > 2) workspaceKeys.add(part.toLowerCase());
		}
		// Add value tokens if string
		if (typeof slot.value === "string") {
			for (const w of slot.value.toLowerCase().split(/[\s_]/)) {
				if (w.length > 2 && w.length < 30) workspaceKeys.add(w);
			}
		}
		// Add source
		for (const part of slot.source.split(":")) {
			if (part.length > 2) workspaceKeys.add(part.toLowerCase());
		}
	}

	const claimed = new Set(probe.extractedConcepts);

	// True positives
	const matched: string[] = [];
	const hallucinated: string[] = [];
	for (const c of claimed) {
		if (workspaceKeys.has(c)) matched.push(c);
		else hallucinated.push(c);
	}

	// False negatives
	const missed: string[] = [];
	for (const k of workspaceKeys) {
		if (!claimed.has(k)) missed.push(k);
	}

	const precision = claimed.size > 0 ? matched.length / claimed.size : 1;
	const recall = workspaceKeys.size > 0 ? matched.length / workspaceKeys.size : 1;
	const f1 = precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : 0;

	return { precision, recall, f1, hallucinated, matched, missed };
}

/**
 * Aggregate multiple probe results into a single reportability result.
 */
export function aggregateReportability(probeResults: ReportabilityResult[]): ReportabilityResult {
	const allProbes = probeResults.flatMap((r) => r.probes);
	if (allProbes.length === 0) {
		return {
			taskId: "(aggregate)",
			probes: [],
			aggregate: {
				totalProbes: 0,
				avgPrecision: 0,
				avgRecall: 0,
				avgF1: 0,
				hallucinationRate: 0,
				predictionAccuracy: 0,
			},
		};
	}

	const scores = allProbes.map(scoreProbe);
	const predictions = allProbes
		.map((p) => ({
			correct: p.nextToolCall
				? p.extractedConcepts.some((c) => p.nextToolCall!.toolName.includes(c) || c.includes(p.nextToolCall!.toolName))
				: null,
		}))
		.filter((p) => p.correct !== null);

	const avgPrecision = scores.reduce((s, sc) => s + sc.precision, 0) / scores.length;
	const avgRecall = scores.reduce((s, sc) => s + sc.recall, 0) / scores.length;
	const avgF1 = scores.reduce((s, sc) => s + sc.f1, 0) / scores.length;
	const hallucinationRate = scores.reduce((s, sc) => s + sc.hallucinated.length, 0) / scores.length;
	const predictionAccuracy =
		predictions.length > 0 ? predictions.filter((p) => p.correct).length / predictions.length : 0;

	return {
		taskId: "(aggregate)",
		probes: allProbes,
		aggregate: {
			totalProbes: allProbes.length,
			avgPrecision,
			avgRecall,
			avgF1,
			hallucinationRate,
			predictionAccuracy,
		},
	};
}

// ─── Report format for agent prompt injection ──────────────

/**
 * Generate the probe prompt to inject mid-task.
 */
export function generateProbePrompt(format: "freeform" | "structured" = "structured"): string {
	if (format === "freeform") {
		return "\n[INTERNAL] Pause and describe what you're currently working on and what you're thinking about. Be specific about the files, code, and concepts in your mind right now.\n";
	}
	return "\n[INTERNAL] Report your current workspace state. List:\n1. What file or code are you focused on?\n2. What's the current goal or subgoal?\n3. What tools have you used recently?\n4. What's your next planned action?\nFormat as bullet points.\n";
}
