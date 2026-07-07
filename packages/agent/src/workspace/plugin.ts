/**
 * Workspace Agent Plugin — wires WorkspaceBus into the agent loop hooks.
 *
 * Rather than modifying agent-loop.ts directly, this module produces the right
 * AgentLoopConfig hooks so the workspace just slots in as a config option.
 * This keeps the fork merge-safe with upstream.
 */

import type { AgentLoopConfig, AgentMessage, AgentToolResult } from "../types";
import { WorkspaceBus, formatWorkspaceForPrompt } from "./bus";
import { defaultToolResultExtractor, makePostToolHook, getRelevantWorkspaceContext } from "./hooks";
import type { WorkspaceSlotKind } from "./slot";

export type { WorkspaceBus } from "./bus";
export { WorkspaceBus } from "./bus";

export interface WorkspacePluginConfig {
	/**
	 * Maximum workspace capacity. 0 = disabled, >0 = enabled.
	 * Default: 0 (disabled). Set to 16 for standard operation.
	 */
	capacity?: number;
	/**
	 * Ablation mode: artificially limit workspace to K slots.
	 * -1 = disabled (use full capacity), 0 = zero workspace, >0 = K limit.
	 */
	ablateTo?: number;
	/**
	 * How many workspace entries to inject into the model context per turn.
	 * 0 = don't inject (workspace is passive monitoring only).
	 */
	injectTopK?: number;
	/**
	 * Custom fact extractor. Defaults to `defaultToolResultExtractor`.
	 */
	extract?: (toolName: string, result: AgentToolResult<unknown>, args: Record<string, unknown>) => Array<{
		key: string;
		value: unknown;
		kind?: WorkspaceSlotKind;
		importance?: number;
		ttl?: number;
	}>;
}

/**
 * Creates an agent loop config enriched with workspace hooks.
 *
 * Usage:
 * ```ts
 * const bus = new WorkspaceBus({ capacity: 16 });
 * const config = withWorkspaceConfig(baseConfig, bus, { injectTopK: 6 });
 * ```
 */
export function withWorkspaceConfig(
	base: AgentLoopConfig,
	bus: WorkspaceBus,
	cfg: WorkspacePluginConfig = {},
): AgentLoopConfig {
	const capacity = cfg.capacity ?? 16;
	const injectTopK = cfg.injectTopK ?? 6;
	const extractor = cfg.extract ?? defaultToolResultExtractor;

	// Enable if capacity > 0
	if (capacity <= 0) return base;

	// Apply ablation if configured
	if (cfg.ablateTo !== undefined && cfg.ablateTo >= 0) {
		bus.setAblation(cfg.ablateTo);
	}

	const postToolHook = makePostToolHook(bus, extractor);

	// ─── Wrapped hooks ─────────────────────────────────────

	/** Inject workspace context before each LLM call. */
	const originalTransform = base.transformContext;
	const wrappedTransform: AgentLoopConfig["transformContext"] = async (messages, signal) => {
		const result = originalTransform ? await originalTransform(messages, signal) : messages;

		if (injectTopK > 0 && bus.size > 0) {
			const top = bus.getTopK(injectTopK);
			if (top.length > 0) {
				const wsBlock = formatWorkspaceForPrompt(top);
				// Append as a system message before the last user message
				if (result.length > 0) {
					const lastIdx = result.length - 1;
					const last = result[lastIdx];
					if (last.role === "user" && typeof last.content === "string") {
						result[lastIdx] = {
							...last,
							content: last.content + "\n\n" + wsBlock,
						};
					}
				}
			}
		}

		return result;
	};

	/** Sync turn state before each model call. */
	const originalSync = base.syncContextBeforeModelCall;
	const wrappedSync: AgentLoopConfig["syncContextBeforeModelCall"] = (context) => {
		bus.advanceTurn();
		if (originalSync) originalSync(context);
	};

	/** Intercept tool execution results. */
	// The agent loop doesn't have a direct post-tool-call hook.
	// We use `transformToolCallArguments` for pre-hook (reading workspace)
	// and rely on `tool.execute()` being wrapped at a higher level.
	const originalTransformArgs = base.transformToolCallArguments;
	const wrappedTransformArgs: AgentLoopConfig["transformToolCallArguments"] = (args, toolName) => {
		const effective = originalTransformArgs ? originalTransformArgs(args, toolName) : args;
		// Pre-hook: read relevant workspace context — logged but not injected here
		// (actual injection happens via transformContext)
		if (injectTopK > 0) {
			getRelevantWorkspaceContext(bus, toolName, effective);
		}
		return effective;
	};

	return {
		...base,
		transformContext: wrappedTransform,
		syncContextBeforeModelCall: wrappedSync,
		transformToolCallArguments: wrappedTransformArgs,
	};

	// NOTE: Post-hook (extracting facts after tool execution) is wired
	// separately via the tool execution wrapper or the SDK integration layer.
	// See `wrapToolExecute` below.
}

/**
 * Wraps a tool execute function to write results to the workspace bus.
 * Use this when you control the tool execution layer.
 *
 * ```ts
 * const wrappedTool = wrapToolWithWorkspace(bus, originalTool);
 * ```
 */
export function wrapToolWithWorkspace<T extends { name: string; execute: Function }>(
	bus: WorkspaceBus,
	tool: T,
	extract?: (toolName: string, result: AgentToolResult<unknown>, args: Record<string, unknown>) => Array<{
		key: string;
		value: unknown;
		kind?: WorkspaceSlotKind;
		importance?: number;
		ttl?: number;
	}>,
): T {
	const extractor = extract ?? defaultToolResultExtractor;
	const originalExecute = tool.execute.bind(tool);

	const wrappedExecute = async (callId: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> => {
		const result = await originalExecute(callId, args, signal);
		if (result && typeof result === "object") {
			const toolResult = result as AgentToolResult<unknown>;
			const entries = extractor(tool.name, toolResult, args);
			for (const e of entries) {
				if (e.key) {
					bus.write(e.key, e.value, `tool:${tool.name}`, e.kind ?? "fact", {
						importance: e.importance,
						ttl: e.ttl,
					});
				}
			}
		}
		return result;
	};

	return new Proxy(tool, {
		get(target, prop) {
			if (prop === "execute") return wrappedExecute;
			const val = Reflect.get(target, prop);
			return typeof val === "function" ? val.bind(target) : val;
		},
	});
}

/**
 * Quickly verify workspace bus behavior — call from a test or eval cell.
 */
export function verifyWorkspaceBus(): { passed: boolean; details: string[] } {
	const details: string[] = [];
	let passed = true;

	try {
		// 1. Basic write/read
		const bus = new WorkspaceBus({ capacity: 8 });
		bus.write("test", "hello", "test", "fact");
		const read = bus.read("test");
		if (read && read.value === "hello") {
			details.push("✅ write/read: basic operation works");
		} else {
			details.push("❌ write/read: value mismatch");
			passed = false;
		}

		// 2. Capacity enforcement
		const bus2 = new WorkspaceBus({ capacity: 3 });
		bus2.write("a", 1, "test", "fact");
		bus2.write("b", 2, "test", "fact");
		bus2.write("c", 3, "test", "fact");
		bus2.write("d", 4, "test", "fact"); // should evict one
		if (bus2.size <= 3) {
			details.push(`✅ capacity: size=${bus2.size} ≤ 3 after 4 writes`);
		} else {
			details.push(`❌ capacity: size=${bus2.size} > 3 after eviction`);
			passed = false;
		}

		// 3. Re-write existing key (should not evict)
		bus2.write("a", 10, "test", "fact"); // update existing
		if (bus2.size === 3) {
			details.push("✅ re-write: size unchanged on key update");
		} else {
			details.push(`❌ re-write: size changed to ${bus2.size}`);
			passed = false;
		}

		// 4. Ablation
		const bus3 = new WorkspaceBus({ capacity: 8 });
		bus3.write("1", "a", "t", "fact");
		bus3.write("2", "b", "t", "fact");
		bus3.write("3", "c", "t", "fact");
		bus3.setAblation(2);
		if (bus3.size <= 2) {
			details.push(`✅ ablation: size=${bus3.size} ≤ 2 after K=2`);
		} else {
			details.push(`❌ ablation: size=${bus3.size} > 2`);
			passed = false;
		}

		// 5. Zero ablation (workspace disabled)
		const bus4 = new WorkspaceBus({ capacity: 8 });
		bus4.write("x", "y", "t", "fact");
		bus4.setAblation(0);
		let threw = false;
		try {
			bus4.write("z", "w", "t", "fact");
		} catch {
			threw = true;
		}
		if (threw) {
			details.push("✅ zero ablation: write to zero-capacity bus throws");
		} else {
			details.push("❌ zero ablation: should have thrown");
			passed = false;
		}

		// 6. getTopK
		const bus5 = new WorkspaceBus({ capacity: 8 });
		bus5.write("high", "important", "t", "fact", { importance: 0.9 });
		bus5.write("low", "trivial", "t", "fact", { importance: 0.1 });
		bus5.write("mid", "normal", "t", "fact", { importance: 0.5 });
		const top = bus5.getTopK(2);
		if (top.length === 2 && top[0].key === "high" && top[1].key === "mid") {
			details.push("✅ getTopK: returns highest importance slots");
		} else {
			details.push(`❌ getTopK: expected high,mid got ${top.map((s) => s.key).join(",")}`);
			passed = false;
		}

		// 7. TTL eviction
		const bus6 = new WorkspaceBus({ capacity: 8 });
		bus6.write("temp", "data", "t", "fact", { ttl: 1 });
		bus6.advanceTurn();
		bus6.advanceTurn(); // TTL exceeded
		if (bus6.size === 0) {
			details.push("✅ TTL: slot evicted after TTL exceeded");
		} else {
			details.push("❌ TTL: slot not evicted");
			passed = false;
		}
	} catch (err) {
		details.push(`❌ exception: ${err}`);
		passed = false;
	}

	details.push(passed ? "✅ ALL PASSED" : "❌ SOME FAILED");
	return { passed, details };
}
