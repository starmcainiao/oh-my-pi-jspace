/**
 * Emergence Analysis (Exp 3) — detect centralized workspace patterns
 * from observation logs.
 *
 * J-space emerged without design in Claude. The question for agent swarms:
 * does a shared broadcast channel naturally develop a "centralized concept set"
 * that multiple agents reference?
 *
 * This module analyzes FileWorkspaceBus observation logs for:
 * - **Centrality**: what concepts are read by the most agents?
 * - **Convergence**: does the active concept set stabilize over time?
 * - **Privilege**: is there a subset of concepts that ALL agents read?
 * - **Capacity saturation**: does the bus fill to a characteristic occupancy?
 */
import type { BusObservation, BusSnapshot } from "./file-workspace-bus";

// ─── Analysis types ──────────────────────────────────────

export interface ConceptStats {
	key: string;
	totalWrites: number;
	totalReads: number;
	readerCount: number;   // unique agents that read this concept
	writerCount: number;   // unique agents that wrote this concept
	lastWriteSeq: number;
	firstWriteSeq: number;
	lifespanSeqs: number;  // sequences between first write and eviction/end
}

export interface AgentParticipation {
	agentId: string;
	writeCount: number;
	readCount: number;
	keysWritten: string[];
	keysRead: string[];
}

export interface CentralityResult {
	/** Concepts ranked by how many agents read them (broadest first). */
	byReadership: ConceptStats[];
	/** Concepts ranked by total reads. */
	byReadVolume: ConceptStats[];
	/** The "core" set: concepts read by >50% of agents. */
	coreConcepts: string[];
	/** The "exclusive" set: concepts written by one agent, read by many. */
	broadcastConcepts: string[];
}

export interface ConvergenceResult {
	/** Bus occupancy at each snapshot. */
	occupancyOverTime: Array<{ seq: number; occupancy: number; capacity: number }>;
	/** Did the concept set size stabilize (variance in last 5 vs first 5 snapshots)? */
	converged: boolean;
	/** Average occupancy in the final quartile of observations. */
	finalOccupancyAvg: number;
	/** Churn rate: fractions of slots replaced per N observations. */
	churnRate: number;
}

export interface EmergenceReport {
	centrality: CentralityResult;
	convergence: ConvergenceResult;
	agents: AgentParticipation[];
	observationCount: number;
	totalAgents: number;
	durationMs: number;
}

// ─── Analysis ─────────────────────────────────────────────

export function analyzeEmergence(
	observations: BusObservation[],
	finalSnapshot: BusSnapshot | null,
): EmergenceReport {
	if (observations.length === 0) {
		return {
			centrality: { byReadership: [], byReadVolume: [], coreConcepts: [], broadcastConcepts: [] },
			convergence: { occupancyOverTime: [], converged: false, finalOccupancyAvg: 0, churnRate: 0 },
			agents: [],
			observationCount: 0,
			totalAgents: 0,
			durationMs: 0,
		};
	}

	const agentSet = new Set<string>();
	const conceptWrites = new Map<string, number>();
	const conceptReads = new Map<string, number>();
	const conceptReaders = new Map<string, Set<string>>();
	const conceptWriters = new Map<string, Set<string>>();
	const conceptFirstSeq = new Map<string, number>();
	const conceptLastSeq = new Map<string, number>();
	const agentStats = new Map<string, { writes: number; reads: number; keysWritten: Set<string>; keysRead: Set<string> }>();
	const occupancyTrace: Array<{ seq: number; occupancy: number; capacity: number }> = [];

	let capacity = 16;

	for (const obs of observations) {
		agentSet.add(obs.agentId);

		// Track per-agent
		if (!agentStats.has(obs.agentId)) {
			agentStats.set(obs.agentId, { writes: 0, reads: 0, keysWritten: new Set(), keysRead: new Set() });
		}

		if (obs.type === "write" && obs.slot) {
			conceptWrites.set(obs.slot.key, (conceptWrites.get(obs.slot.key) ?? 0) + 1);
			if (!conceptFirstSeq.has(obs.slot.key)) conceptFirstSeq.set(obs.slot.key, obs.seq);
			conceptLastSeq.set(obs.slot.key, obs.seq);

			const writers = conceptWriters.get(obs.slot.key) ?? new Set();
			writers.add(obs.agentId);
			conceptWriters.set(obs.slot.key, writers);

			const stats = agentStats.get(obs.agentId)!;
			stats.writes++;
			stats.keysWritten.add(obs.slot.key);
		}

		if (obs.type === "read" && obs.slot) {
			conceptReads.set(obs.slot.key, (conceptReads.get(obs.slot.key) ?? 0) + 1);

			const readers = conceptReaders.get(obs.slot.key) ?? new Set();
			readers.add(obs.agentId);
			conceptReaders.set(obs.slot.key, readers);

			const stats = agentStats.get(obs.agentId)!;
			stats.reads++;
			stats.keysRead.add(obs.slot.key);
		}

		if (obs.type === "snapshot" && obs.snapshot) {
			if (finalSnapshot) capacity = finalSnapshot.capacity;
			occupancyTrace.push({ seq: obs.seq, occupancy: obs.snapshot.length, capacity });
		}
	}

	// Build concept stats
	const allKeys = new Set([...conceptWrites.keys(), ...conceptReads.keys()]);
	const conceptStats: ConceptStats[] = [];
	for (const key of allKeys) {
		const readers = conceptReaders.get(key) ?? new Set();
		const writers = conceptWriters.get(key) ?? new Set();
		conceptStats.push({
			key,
			totalWrites: conceptWrites.get(key) ?? 0,
			totalReads: conceptReads.get(key) ?? 0,
			readerCount: readers.size,
			writerCount: writers.size,
			firstWriteSeq: conceptFirstSeq.get(key) ?? 0,
			lastWriteSeq: conceptLastSeq.get(key) ?? 0,
			lifespanSeqs: (conceptLastSeq.get(key) ?? 0) - (conceptFirstSeq.get(key) ?? 0),
		});
	}

	// Centrality
	const byReadership = [...conceptStats].sort((a, b) => b.readerCount - a.readerCount);
	const byReadVolume = [...conceptStats].sort((a, b) => b.totalReads - a.totalReads);
	const totalAgents = agentSet.size;
	const coreThreshold = Math.max(1, Math.ceil(totalAgents * 0.5));
	const coreConcepts = byReadership.filter((c) => c.readerCount >= coreThreshold).map((c) => c.key);
	const broadcastConcepts = conceptStats
		.filter((c) => c.writerCount === 1 && c.readerCount > 1)
		.sort((a, b) => b.readerCount - a.readerCount)
		.map((c) => c.key);

	// Convergence
	const converged = occupancyTrace.length >= 6
		? variance(occupancyTrace.slice(-5).map((t) => t.occupancy)) < variance(occupancyTrace.slice(0, 5).map((t) => t.occupancy))
		: false;

	const finalQuarter = occupancyTrace.slice(Math.floor(occupancyTrace.length * 0.75));
	const finalOccupancyAvg =
		finalQuarter.length > 0
			? finalQuarter.reduce((s, t) => s + t.occupancy, 0) / finalQuarter.length
			: 0;

	const churnRate = observations.length > 0
		? observations.filter((o) => o.type === "evict").length / observations.length
		: 0;

	// Duration
	const firstTs = observations.length > 0 ? new Date(observations[0].timestamp).getTime() : Date.now();
	const lastTs = observations.length > 0 ? new Date(observations[observations.length - 1].timestamp).getTime() : Date.now();

	return {
		centrality: {
			byReadership,
			byReadVolume,
			coreConcepts,
			broadcastConcepts,
		},
		convergence: {
			occupancyOverTime: occupancyTrace,
			converged,
			finalOccupancyAvg,
			churnRate,
		},
		agents: [...agentStats.entries()]
			.map(([agentId, s]) => ({
				agentId,
				writeCount: s.writes,
				readCount: s.reads,
				keysWritten: [...s.keysWritten].sort(),
				keysRead: [...s.keysRead].sort(),
			}))
			.sort((a, b) => b.writeCount - a.writeCount),
		observationCount: observations.length,
		totalAgents: agentSet.size,
		durationMs: lastTs - firstTs,
	};
}

// ─── Helpers ──────────────────────────────────────────────

function variance(values: number[]): number {
	if (values.length < 2) return 0;
	const mean = values.reduce((s, v) => s + v, 0) / values.length;
	const sqDiffs = values.map((v) => (v - mean) ** 2);
	return sqDiffs.reduce((s, v) => s + v, 0) / values.length;
}
