# Workspace Bus — J-Space Agent Analogy

## Core idea

J-space in Claude is a **small, privileged set of internal representations** that:
- can be reported / verbalized
- can be voluntarily modulated
- causally mediate multi-step reasoning
- are flexibly usable across tasks
- are **not** involved in routine/automatic processing

The **Workspace Bus** maps these properties to the agent orchestration layer:

| J-space property | Agent implementation |
|---|---|
| Finite capacity (~dozens) | Fixed K-slot array (4/8/16/32) |
| Global broadcast | All subagents + tools share one bus |
| Reportable | Agent can dump workspace when asked |
| Flexible reuse | One slot feeds multiple downstream consumers |
| Causal mediation | Ablating workspace content degrades multi-step reasoning |

## Architecture

```
┌─────────────────────────────────────────┐
│            Workspace Bus                │
│  ┌──────┐ ┌──────┐        ┌──────┐     │
│  │slot 1│ │slot 2│  ...   │slot K│     │
│  └──────┘ └──────┘        └──────┘     │
│         eviction: LRU + importance      │
└────────────────┬────────────────────────┘
                 │
    ┌────────────┼────────────┐
    ▼            ▼            ▼
  pre-hook    post-hook    intent-monitor
  (prompt     (extract     (reportability /
   injection)   key=value)   ablation)
```

### Slot structure

```ts
interface WorkspaceSlot {
  key: string;           // short identifier, e.g. "current_file", "last_error"
  value: unknown;        // any JSON-serializable value
  source: string;        // component that wrote it, e.g. "read", "bash", "subagent:fe"
  kind: "fact" | "intent" | "intermediate" | "error";
  timestamp: number;     // write time (monotonic)
  turnCreated: number;   // agent turn when created
  ttl: number;           // turns before auto-evict (0 = eternal)
  importance: number;    // 0.0–1.0, for eviction ordering
  readCount: number;     // how many times read
  lastReadTurn: number;  // last turn when read
}
```

## Hook integration points

### 1. `preToolCall(toolName, args) → promptSnippets`

Called before each tool execution. Reads workspace entries relevant to the current tool, returns text snippets to inject into the model's context.

- `read` → inject `current_file`, `last_grep_pattern`
- `edit` → inject `current_file`, `last_read_range`
- `bash` → inject `last_error`, `last_bash_command`

### 2. `postToolCall(result) → void`

Called after each tool execution. Extracts structured information from the result and writes to workspace.

- `read` → key=`read:{path}`, value=file summary
- `grep` → key=`grep:{pattern}`, value=match count + first match
- `bash` → key=`bash:last`, value=exit code + summary
- `edit` → key=`edit:last`, value=file + lines changed

### 3. `injectIntoPrompt() → string`

Generates a compact prompt snippet from the top-K workspace entries. Called by `transformContext` hook.

### 4. `ablate(keepK: number) → void`

Truncates workspace to K most important entries. Used in bandwidth experiments.

## Experiments

### Exp 2 — Bandwidth ablation

1. Run N multi-step agent tasks with unlimited workspace (control)
2. Run same tasks with K=4/8/16/32
3. Run same tasks with workspace completely disabled
4. Measure: completion rate, tool call accuracy, tokens, turns

### Exp 5 — Reportability

1. At random midpoint of agent tasks, inject "report your workspace"
2. Collect agent's report
3. Compare report to actual workspace content (precision/recall)
4. Compare report to actual tool call sequence (correlation)

## Files

- `bus.ts` — WorkspaceBus implementation
- `slot.ts` — Slot types and helpers
- `eviction.ts` — Eviction strategies
- `hooks.ts` — Pre/post tool-call hook helpers
- `index.ts` — re-exports
- `experiments/ablation.ts` — ablation experiment harness
- `experiments/reportability.ts` — reportability experiment harness
- `DESIGN.md` — this file
