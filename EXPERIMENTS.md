# J-Space Agent Analogy — omp-jspace Experiments

**Branch:** `jspace/workspace-bus`
**Base:** `can1357/oh-my-pi` @ main
**Start date:** 2026-07-07

## Research Question

> Can the Global Workspace Theory (GWT) properties observed in Claude's neural
> J-space be replicated at the **agent orchestration layer** — not in neural
> activations, but in the structured coordination of subagents, tools, and
> decision-making?

## Key Hypothesis

An agent harness with a **finite, shared, globally-visible workspace bus** will
exhibit the same five functional properties GWT predicts for conscious access:

1. **Reportability** — the agent can describe its workspace contents
2. **Voluntary modulation** — the agent can control what enters the workspace
3. **Causal mediation** — workspace content drives multi-step reasoning
4. **Flexible reuse** — one workspace entry serves multiple downstream tasks
5. **Automatic processing bypass** — routine tasks don't need the workspace

## Experiments

### Exp 1: Workspace Bus Implementation [Foundation]

**Status:** Built.
**Module:** `packages/agent/src/workspace/`

- `WorkspaceBus` class with K-slot capacity, LRU+importance eviction, TTL
- Pre/post tool-call hooks for automatic fact extraction
- Prompt injection helpers via `transformContext`

### Exp 2: Bandwidth Ablation [Core]

**Status:** Harness built, awaiting execution.

Replicates: *"Deleting the J-space causes multi-step reasoning to drop to near
zero, while fluent speech and simple tasks remain unaffected."*

**Protocol:**

| Condition | Workspace config | Expected effect on simple tasks | Expected effect on multi-step |
|-----------|-----------------|-------------------------------|------------------------------|
| CONTROL | K=32 (unlimited) | ✅ Normal | ✅ Normal |
| ABLATED_K8 | K=8 | ✅ Normal (slight) | ⚠️ Degraded |
| ABLATED_K4 | K=4 | ✅ Normal | ❌ Significant drop |
| ZERO | K=0 (disabled) | ✅ Normal | ❌ Near zero |

**Tasks:** 8 benchmark tasks — 3 simple, 3 multi-step, 2 creative
**Metrics:** completion rate, tool call accuracy, tokens, turns, error rate
**Expected result:** Simple tasks should be largely unaffected across all
conditions. Multi-step tasks should degrade monotonically with capacity.

### Exp 3: Emergence Analysis [Observational]

**Status:** Planned.

Replicates: *"J-space wasn't designed; it emerged during training."*

Instead of pre-designing workspace structure, provide an append-only broadcast
channel and let subagent IRC traffic self-organize. Analyze post-hoc:

- Do certain concepts get referenced by multiple subagents? (centrality)
- Does the active concept set converge to a stable size?
- Is there a "privileged subset" that all subagents read from?

**Tool:** IRC traffic recorder + concept clustering

### Exp 4: Stream Rule × Workspace Pre-emption [Engineering]

**Status:** Planned.

Current stream rules fire on output tokens (reactive). Workspace rules fire on
workspace writes (proactive, before tool execution).

- Current: model writes `Box::leak` → stream rule aborts → injects rule → retry
- Workspace: post-hook detects `intent:edit` with dangerous pattern → injects
  constraint before tool executes

### Exp 5: Reportability [Core]

**Status:** Harness built, awaiting execution.

Replicates: *"Claude can report what's in its J-space, and the report matches
its actual internal state."*

**Protocol:**
1. Run multi-step tasks
2. At random midpoint, inject "report your workspace" prompt
3. Collect agent report + workspace snapshot simultaneously
4. Compare: precision, recall, F1 of claimed vs actual contents
5. Measure: does reported "next intent" predict the actual next tool call?

**Metrics:**
- Precision: % of claimed concepts actually in workspace
- Recall: % of actual workspace concepts claimed
- Hallucination rate: claimed concepts NOT in workspace
- Prediction accuracy: reported next-intent matches actual next-tool

**Expected result:** Precision/recall should be significantly above chance,
indicating the workspace bus genuinely mediates the agent's "awareness" of its
own state.

### Exp 6: J-Space Injection [Exploratory]

**Status:** Planned.

Replicates: *"Injecting 'Rugby' into J-space changes Claude's answer."*

If we write a false/alternative fact into the workspace bus, does the agent
follow it? Test with:

- Write `current_file = "src/wrong.ts"` → does the agent read the wrong file?
- Override `last_error = "undefined"` → does the agent think there's no error?
- Inject `intent = "abort"` → does the agent stop working?

## Implementation Status

| Module | Status | Lines |
|--------|--------|-------|
| `workspace/slot.ts` | ✅ Done | ~80 |
| `workspace/eviction.ts` | ✅ Done | ~100 |
| `workspace/bus.ts` | ✅ Done | ~230 |
| `workspace/hooks.ts` | ✅ Done | ~190 |
| `workspace/experiments/ablation.ts` | ✅ Done | ~200 |
| `workspace/experiments/reportability.ts` | ✅ Done | ~220 |
| Agent loop integration | ⏳ Pending | — |
| Swarm extension | 📋 Planned | — |
| IRC emergence recorder | 📋 Planned | — |

## Running Experiments

```bash
# Type check
cd packages/agent && bun run check:types

# Run workspace unit tests
bun test workspace

# Run ablation experiment (requires agent + model)
bun run experiments:ablation

# Run reportability experiment
bun run experiments:reportability
```

## Expected Timeline

1. **Week 1:** Workspace bus + hooks (✅)
2. **Week 2:** Agent loop integration + unit tests
3. **Week 3-4:** Ablation experiment execution + analysis
4. **Week 5:** Reportability experiment execution + analysis
5. **Week 6:** Emergence analysis (IRC recording)
6. **Week 7:** Write-up + blog post
