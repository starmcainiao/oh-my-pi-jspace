---
name: jspace-workbench
description: Experiment with the J-space / Global Workspace analogy at the agent orchestration level. Run ablation experiments, reportability tests, and analyze workspace bus behavior. Use when the user wants to run, configure, or analyze J-space workspace experiments in oh-my-pi.
---

# J-Space Workbench

Experiments porting Global Workspace Theory (GWT) from neural activations to agent orchestration. Implements a `WorkspaceBus` — a finite, shared, globally-visible coordination channel analogous to Claude's J-space.

## Quick start

```bash
# Verify the workspace bus works
bun eval -e "
const { verifyWorkspaceBus } = require('@oh-my-pi/pi-agent-core/workspace/plugin');
const result = verifyWorkspaceBus();
console.log(result.details.join('\\n'));
console.log(result.passed ? '✅ PASS' : '❌ FAIL');
"

# Run ablation experiment (requires model access)
bun run packages/agent/src/workspace/experiments/run-ablation.ts
```

## Commands

### /jspace status

Show current workspace bus state: capacity, size, active slots, ablation mode.

### /jspace snapshot

Dump full workspace contents (for reportability comparison).

### /jspace configure

| Option | Values | Description |
|--------|--------|-------------|
| capacity | 4, 8, 16, 32 | Max workspace slots |
| ablate | 0, 4, 8, off | Ablation mode (limit slots) |
| inject | 0-8 | Slots to inject into prompt per turn |

### /jspace experiment

Run a controlled experiment:

```bash
# Exp 2: Bandwidth ablation
/jspace experiment ablation --tasks multi_debug,multi_find_edit --configs control,k8,k4,zero

# Exp 5: Reportability
/jspace experiment reportability --tasks multi_debug --probes 3
```

### /jspace trace

Enable workspace tracing: record every write/evict/read to a timeline file for post-hoc analysis.

## Experiment reference

See [EXPERIMENTS.md](/EXPERIMENTS.md) for full protocol.

## Files

- `packages/agent/src/workspace/bus.ts` — Core bus implementation
- `packages/agent/src/workspace/hooks.ts` — Pre/post tool-call hooks
- `packages/agent/src/workspace/plugin.ts` — Agent loop integration
- `packages/agent/src/workspace/experiments/ablation.ts` — Ablation harness
- `packages/agent/src/workspace/experiments/reportability.ts` — Reportability harness
- `EXPERIMENTS.md` — Full experiment protocol + status
