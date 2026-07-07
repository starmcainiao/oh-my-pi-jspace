/**
 * FileWorkspaceBus — persistent, observable workspace bus for swarm agents.
 *
 * Two layers:
 * 1. Observation — every mutation is append-logged to `observations.ndjson`
 *    for real-time monitoring and post-hoc analysis
 * 2. Storage — full state snapshots to `bus.json` at configurable intervals
 *    (wave boundaries, agent completions, iteration boundaries)
 *
 * Designed for the swarm extension: each subagent reads/writes the bus via
 * filesystem, and the orchestrator syncs at coordination boundaries.
 */
import * as path from "node:path";
import {
	WorkspaceBus,
	type WorkspaceSlot,
	type WorkspaceSlotKind,
	type WorkspaceChangeEvent,
} from "../../agent/src/workspace/index";

/**
 * A single observation written to the append log.
 * The full event history allows post-hoc emergence analysis (Exp 3).
 */
export interface BusObservation {
	seq: number;
	timestamp: string;
	type: "write" | "evict" | "clear" | "ablate" | "snapshot" | "read";
	agentId: string;
	slot?: {
		key: string;
		value: unknown;
		source: string;
		kind: WorkspaceSlotKind;
		importance: number;
	};
	evicted?: Array<{ key: string; kind: WorkspaceSlotKind; reason: string }>;
	snapshot?: Array<{
		key: string;
		value: unknown;
		source: string;
		kind: WorkspaceSlotKind;
	}>;
}

/**
 * Full state snapshot for disk persistence.
 */
export interface BusSnapshot {
	version: 1;
	createdAt: string;
	updatedAt: string;
	capacity: number;
	agentId: string;
	slots: Record<
		string,
		{
			value: unknown;
			source: string;
			kind: WorkspaceSlotKind;
			importance: number;
			createdTurn: number;
			ttl: number;
		}
	>;
}

export interface FileWorkspaceBusOptions {
	busDir: string;
	agentId?: string;
	capacity?: number;
	snapshotInterval?: "never" | "wave" | "agent" | "iteration" | "every";
}

export class FileWorkspaceBus {
	private bus: WorkspaceBus;
	private readonly busDir: string;
	private readonly agentId: string;
	private readonly snapshotInterval: NonNullable<FileWorkspaceBusOptions["snapshotInterval"]>;
	private seq = 0;
	private obsPath: string;
	private snapPath: string;

	constructor(options: FileWorkspaceBusOptions) {
		this.bus = new WorkspaceBus({ capacity: options.capacity ?? 16 });
		this.busDir = options.busDir;
		this.agentId = options.agentId ?? "unknown";
		this.snapshotInterval = options.snapshotInterval ?? "every";
		this.obsPath = path.join(this.busDir, "observations.ndjson");
		this.snapPath = path.join(this.busDir, "bus.json");

		this.bus.onChange((event) => {
			this.recordObservation(event);
		});
	}

	get underlying(): WorkspaceBus {
		return this.bus;
	}

	async init(): Promise<void> {
		const fs = await import("node:fs/promises");
		await fs.mkdir(this.busDir, { recursive: true });
		await this.writeSnapshot();
	}

	write<T>(
		key: string,
		value: T,
		source: string,
		kind: WorkspaceSlotKind = "fact",
		opts?: { ttl?: number; importance?: number },
	): void {
		this.bus.write(key, value, source, kind, opts);
	}

	read<T = unknown>(key: string): WorkspaceSlot<T> | undefined {
		const slot = this.bus.read(key) as WorkspaceSlot<T> | undefined;
		if (slot) {
			this.recordRead(key, slot);
		}
		return slot;
	}

	readValue<T = unknown>(key: string): T | undefined {
		return this.bus.readValue<T>(key);
	}

	query(prefix: string): WorkspaceSlot[] {
		return this.bus.query(prefix);
	}

	getTopK(k: number): WorkspaceSlot[] {
		return this.bus.getTopK(k);
	}

	snapshot(): WorkspaceSlot[] {
		return this.bus.snapshot();
	}

	get size(): number {
		return this.bus.size;
	}

	get capacity(): number {
		return this.bus.limit;
	}

	/** Call at wave boundaries. */
	async onWaveComplete(waveIndex: number, _waveAgents: string[]): Promise<void> {
		if (this.snapshotInterval === "wave" || this.snapshotInterval === "every") {
			await this.writeSnapshot();
		}
		const obs: BusObservation = {
			seq: this.nextSeq(),
			timestamp: new Date().toISOString(),
			type: "snapshot",
			agentId: this.agentId,
			snapshot: this.bus.snapshot().map((s) => ({
				key: s.key,
				value: s.value,
				source: s.source,
				kind: s.kind,
			})),
		};
		await this.appendObservation(obs);
	}

	/** Call when an agent completes. */
	async onAgentComplete(_agentName: string): Promise<void> {
		if (this.snapshotInterval === "agent" || this.snapshotInterval === "every") {
			await this.writeSnapshot();
		}
	}

	/** Call at iteration boundaries. */
	async onIterationComplete(_iteration: number): Promise<void> {
		if (this.snapshotInterval === "iteration" || this.snapshotInterval === "every") {
			await this.writeSnapshot();
		}
	}

	/** Merge external snapshot into this bus. */
	mergeExternal(snapshot: Record<string, { value: unknown; source: string; kind: WorkspaceSlotKind; importance: number }>): void {
		for (const [key, entry] of Object.entries(snapshot)) {
			this.bus.write(key, entry.value, `external:${entry.source}`, entry.kind, { importance: entry.importance });
		}
	}

	async writeSnapshot(): Promise<void> {
		const slots = this.bus.snapshot();
		const snapshot: BusSnapshot = {
			version: 1,
			createdAt: this.bus.getWriteCount() === 0 ? new Date(Date.now()).toISOString() : new Date(Date.now() - 1000).toISOString(),
			updatedAt: new Date().toISOString(),
			capacity: this.bus.limit,
			agentId: this.agentId,
			slots: {},
		};
		for (const s of slots) {
			snapshot.slots[s.key] = {
				value: s.value,
				source: s.source,
				kind: s.kind,
				importance: s.importance,
				createdTurn: s.turnCreated,
				ttl: s.ttl,
			};
		}
		const fs = await import("node:fs/promises");
		await fs.writeFile(this.snapPath, JSON.stringify(snapshot, null, 2));
	}

	async loadSnapshot(): Promise<void> {
		const fs = await import("node:fs/promises");
		let content: string;
		try {
			content = await fs.readFile(this.snapPath, "utf-8");
		} catch {
			return;
		}
		const data = JSON.parse(content) as BusSnapshot;
		this.bus.clear();
		for (const [key, entry] of Object.entries(data.slots)) {
			this.bus.write(key, entry.value, entry.source, entry.kind, {
				importance: entry.importance,
				ttl: entry.ttl,
			});
		}
	}

	async getObservationLog(): Promise<BusObservation[]> {
		const fs = await import("node:fs/promises");
		try {
			const content = await fs.readFile(this.obsPath, "utf-8");
			return content
				.trim()
				.split("\n")
				.filter(Boolean)
				.map((line) => JSON.parse(line) as BusObservation);
		} catch {
			return [];
		}
	}

	async clearObservations(): Promise<void> {
		const fs = await import("node:fs/promises");
		await fs.writeFile(this.obsPath, "");
	}

	async exportAnalysisData(): Promise<{
		observations: BusObservation[];
		snapshot: BusSnapshot | null;
	}> {
		return {
			observations: await this.getObservationLog(),
			snapshot: await this.readSnapshotFile(),
		};
	}

	private nextSeq(): number {
		return ++this.seq;
	}

	private recordObservation(event: WorkspaceChangeEvent): void {
		const obs: BusObservation = {
			seq: this.nextSeq(),
			timestamp: new Date(event.timestamp).toISOString(),
			type: event.type,
			agentId: this.agentId,
		};
		if (event.slot) {
			obs.slot = {
				key: event.slot.key,
				value: event.slot.value,
				source: event.slot.source,
				kind: event.slot.kind,
				importance: event.slot.importance,
			};
		}
		if (event.evicted && event.evicted.length > 0) {
			obs.evicted = event.evicted.map((s) => ({
				key: s.key,
				kind: s.kind,
				reason: event.reason ?? "unknown",
			}));
		}
		this.appendObservation(obs).catch(() => {});
	}

	private recordRead(key: string, slot: WorkspaceSlot): void {
		const obs: BusObservation = {
			seq: this.nextSeq(),
			timestamp: new Date().toISOString(),
			type: "read",
			agentId: this.agentId,
			slot: {
				key,
				value: slot.value,
				source: slot.source,
				kind: slot.kind,
				importance: slot.importance,
			},
		};
		this.appendObservation(obs).catch(() => {});
	}

	private async appendObservation(obs: BusObservation): Promise<void> {
		const fs = await import("node:fs/promises");
		await fs.appendFile(this.obsPath, JSON.stringify(obs) + "\n");
	}

	private async readSnapshotFile(): Promise<BusSnapshot | null> {
		const fs = await import("node:fs/promises");
		try {
			const content = await fs.readFile(this.snapPath, "utf-8");
			return JSON.parse(content) as BusSnapshot;
		} catch {
			return null;
		}
	}
}
