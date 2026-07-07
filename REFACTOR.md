# jspace/workspace-bus 改造任务书

**版本：** 2026-07-07  
**目标分支：** `jspace/workspace-bus`  
**工作目录：** 项目根 `/Volumes/macos/oh-my-pi-jspace`（或等价路径）  
**受托模型须知：** 本文档自包含，无需阅读其他上下文。按任务顺序逐一完成，每个任务完成后运行验证命令再继续。

---

## 一、项目背景

该分支实现了一个"工作空间总线"（WorkspaceBus）——用于在代理编排层复现 Global Workspace Theory (GWT) 的五个功能属性。核心设计类比 Claude 神经网络中的 J-space：一块有限容量的全局共享内存，所有工具调用的中间结果、意图、事实都写入此处，代理可读取并注入到上下文中。

**当前状态：** 核心实现已完成，但缺乏测试，且有一处已知 bug。

---

## 二、技术栈与规范

```
运行时：      Bun 1.3.14+（不是 Node.js）
测试框架：    bun:test（import from "bun:test"）
语言：        TypeScript（严格，无 any）
格式化：      Biome（Tab 缩进，3空格宽，120字符行宽）
私有字段：    ES # 语法（#field），不用 private 关键词
Promise：     Promise.withResolvers()，不用 new Promise()
文件操作：    Bun.file() / Bun.write()，目录操作用 node:fs/promises
禁止：        console.log（破坏 TUI，用 logger 替代）
禁止：        any、ReturnType<>、动态 import()
```

---

## 三、文件地图（改造涉及的所有文件）

```
packages/agent/src/workspace/
  ├── bus.ts            (296行)  WorkspaceBus 类
  ├── slot.ts           (75行)   WorkspaceSlot 接口与工厂
  ├── eviction.ts       (94行)   4种驱逐策略
  ├── hooks.ts          (248行)  工具调用提取与上下文注入
  ├── plugin.ts         (285行)  代理循环集成（含内置验证函数）
  ├── index.ts          (17行)   导出目录
  └── experiments/
      └── ablation.ts   (226行)  实验框架（有 bug）

packages/swarm-extension/src/
  ├── file-workspace-bus.ts   (323行)  持久化总线
  ├── emergence-analysis.ts   (222行)  涌现分析
  └── swarm/
      ├── schema.ts     (158行)  YAML→SwarmDefinition 解析
      ├── dag.ts        (147行)  DAG 构建与波次计算
      ├── pipeline.ts   (213行)  流水线执行控制器
      ├── state.ts      (128行)  状态持久化
      └── __tests__/
          └── executor.test.ts  (68行，仅1个测试，现存文件)
```

---

## 四、任务一：workspace/ 单元测试（最高优先级）

**目标文件：** `packages/agent/src/workspace/__tests__/`（目录不存在，需新建）

`plugin.ts` 第 186-285 行的 `verifyWorkspaceBus()` 函数里已有 7 个手写验证场景，但它不是正式测试文件。把这些场景迁移并扩展为正式的 `bun:test` 测试，同时补充 hooks.ts 的测试。

### 4.1 新建 bus.test.ts

**路径：** `packages/agent/src/workspace/__tests__/bus.test.ts`

用 `bun:test` 编写，测试 `WorkspaceBus` 的所有核心行为。下面列出要覆盖的场景，具体断言自行设计：

**基础操作（5个用例）：**
1. `write + read`：写入后读取，value 相同，readCount 变为 1
2. `re-write 同一 key`：不增加 size，TTL 重置，旧的 readCount 保留
3. `readValue`：返回 T 或 undefined（key 不存在时）
4. `remove`：删除后 read 返回 undefined，触发 evict 事件
5. `clear`：清空后 size === 0，触发 clear 事件

**容量与驱逐（4个用例）：**
6. 写入 capacity+1 个不同 key 后，size 不超过 capacity
7. `lru` 策略：最近读过的 key 不被驱逐
8. `fifo` 策略：最早写入的 key 最先被驱逐
9. `importance` 策略：importance 最低的 key 被驱逐

**TTL（2个用例）：**
10. 写入 ttl=1 的 slot，advanceTurn() 两次后，slot 消失
11. ttl=0 的 slot 永不自动驱逐

**Ablation（3个用例）：**
12. `setAblation(2)` 在有3个slot时，立即驱逐到 size<=2
13. `setAblation(0)` 后 write 抛 Error
14. `disableAblation()` 后恢复正常容量

**事件系统（2个用例）：**
15. onChange 回调在 write 时收到 `{ type: "write", slot }` 事件
16. onChange 返回的取消函数调用后，后续写入不再触发回调

**查询（2个用例）：**
17. `getTopK(2)` 返回 importance 最高的2个，顺序正确
18. `query("grep:")` 返回所有 key 包含 "grep:" 的 slot，`queryKind("error")` 返回所有 kind=error 的 slot

**总计：18 个用例**

### 4.2 新建 eviction.test.ts

**路径：** `packages/agent/src/workspace/__tests__/eviction.test.ts`

**用例（4个）：**
1. `findExpired`：currentTurn=5，ttl=3，turnCreated=1 → 被选中；ttl=0 → 不选中
2. `pickVictim` lru：lastReadTurn 最小的被选中
3. `pickVictim` lru_importance：70%权重判断——lastReadTurn 很旧但 importance 极高的，不如 lastReadTurn 一般但 importance 极低的更容易被驱逐
4. `truncateTo`：5个 slot 截到 2 个，evicted 恰好有 3 个，kept 的 importance 高于 evicted 的

### 4.3 新建 hooks.test.ts

**路径：** `packages/agent/src/workspace/__tests__/hooks.test.ts`

需要 mock `AgentToolResult`。WorkspaceBus 真实实例化，不 mock。

**用例（6个）：**
1. `defaultToolResultExtractor` 处理 `read` 工具：args.path 为 "/foo/bar.ts"，result 含文本内容 → extractions 包含 key="read:/foo/bar.ts"，kind="fact"
2. `defaultToolResultExtractor` 处理 `bash` 工具成功：result.isError=false → key="bash:ok"，kind="fact"
3. `defaultToolResultExtractor` 处理 `bash` 工具失败：result.isError=true → key="bash:error"，kind="error"，importance=0.9
4. `defaultToolResultExtractor` 处理 args.i 字段存在：额外产生 key="intent:<toolName>"，kind="intent"
5. `makePostToolHook`：调用 hook 后，bus 中出现对应 slot（端到端集成）
6. `getRelevantWorkspaceContext`：bus 中有 read:/foo.ts 的 slot，对 read 工具查询时，返回包含该文件信息的字符串

**mock `AgentToolResult` 的最小结构：**
```typescript
function makeTextResult(text: string, isError = false) {
   return {
      content: [{ type: "text" as const, text }],
      isError,
   };
}
```

### 4.4 验证命令

```bash
cd packages/agent
bun test src/workspace/__tests__
```

全部通过后继续下一个任务。

---

## 五、任务二：swarm/ 测试补全

现有的 `executor.test.ts` 只有 1 个测试（验证 modelRegistry 传递）。需要为其他模块补充测试。

### 5.1 新建 schema.test.ts

**路径：** `packages/swarm-extension/src/swarm/__tests__/schema.test.ts`

测试 `parseSwarmYaml` 和 `validateSwarmDefinition`。

**用例（7个）：**

1. **最小合法 YAML 解析成功**：
   ```yaml
   swarm:
     name: test-swarm
     workspace: /tmp/test
     agents:
       worker:
         role: developer
         task: write code
   ```
   断言：def.name="test-swarm", def.mode="sequential"（默认）, def.agents.size=1

2. **缺少 name 抛错**：去掉 name 字段，expect `parseSwarmYaml` 抛出包含 "name" 的错误

3. **缺少 swarm 顶级键抛错**：YAML 根是 `{ foo: 1 }`，抛出包含 "swarm" 的错误

4. **mode 解析正确**：mode=pipeline → def.mode="pipeline"；mode=parallel → def.mode="parallel"；非法 mode → 抛错

5. **agent waits_for 解析**：配置 `waits_for: [agent_a]` → agent.waitsFor=["agent_a"]

6. **validateSwarmDefinition — waits_for 引用不存在的 agent**：
   ```typescript
   const def = parseSwarmYaml(`swarm: { name: x, workspace: /tmp, agents: { a: { role: r, task: t, waits_for: [nonexistent] } } }`)
   const errors = validateSwarmDefinition(def)
   expect(errors.length).toBeGreaterThan(0)
   ```

7. **validateSwarmDefinition — 自引用**：agent a 的 waits_for 包含 "a" → 有错误

### 5.2 新建 dag.test.ts

**路径：** `packages/swarm-extension/src/swarm/__tests__/dag.test.ts`

测试 `buildDependencyGraph`、`detectCycles`、`buildExecutionWaves`。

**用例（5个）：**

1. **parallel 模式无依赖**：3个 agent，parallel 模式，没有 waits_for → 所有 agent 在 wave 0 一起执行（1个波次，3个 agent）

2. **sequential 模式自动链式**：3个 agent（a, b, c），sequential 模式，无显式 waits_for → 产生3个波次，顺序 a → b → c

3. **显式依赖形成波次**：a 无依赖，b waits_for a，c waits_for a → wave 0=[a]，wave 1=[b,c]（顺序可任意，只要 b 和 c 在同一波次）

4. **detectCycles — 无环图返回 null**：a → b → c，无环 → null

5. **detectCycles — 有环返回涉及节点**：a waits_for b，b waits_for a → 返回包含 a 和 b 的数组

**构造 SwarmDefinition 的辅助函数：**
```typescript
function makeSimpleDef(
   agents: Array<{ name: string; waitsFor?: string[] }>,
   mode: "pipeline" | "parallel" | "sequential" = "sequential",
): SwarmDefinition {
   return {
      name: "test",
      workspace: "/tmp",
      mode,
      targetCount: 1,
      agents: new Map(agents.map(a => [a.name, {
         name: a.name, role: "r", task: "t",
         reportsTo: [], waitsFor: a.waitsFor ?? [],
      }])),
      agentOrder: agents.map(a => a.name),
   };
}
```

### 5.3 新建 state.test.ts

**路径：** `packages/swarm-extension/src/swarm/__tests__/state.test.ts`

测试 `StateTracker` 的持久化与读取。使用真实文件系统（`fs.mkdtemp`），`afterEach` 清理。

**用例（4个）：**

1. **init 创建目录结构**：init 后，`tmpdir/.swarm_<name>/state/` 和 `logs/` 目录存在

2. **updateAgent 持久化**：调用 `updateAgent("a", { status: "running" })` 后，load() 返回的 state.agents.a.status === "running"

3. **appendLog 写文件**：appendLog("a", "hello") 后，`logs/a.log` 存在且包含 "hello"

4. **load 后 state 恢复**：创建新 StateTracker 实例（相同路径），load() 后 state 与 init 时一致

### 5.4 验证命令

```bash
cd packages/swarm-extension
bun test src/swarm/__tests__
```

---

## 六、任务三：修复 ablation.ts 中的 byComplexity bug

**文件：** `packages/agent/src/workspace/experiments/ablation.ts`  
**位置：** 第 122-160 行，`aggregateAblationResults` 函数

### 6.1 问题描述

第 133-136 行的 for 循环是空的（带注释 "We don't have complexity info..."），导致 `byComplexity` 所有字段永远为零，实验报告数据缺失。

```typescript
// 当前代码（第133-136行）——空循环，什么都不做
for (const t of tasks) {
   // We don't have complexity info on TaskResult directly, so we reconstruct
   // from taskId naming convention or later from the benchmark spec
}
```

### 6.2 约定

`getDefaultBenchmarkTasks()`（第164-225行）返回的任务 id 命名规范是：`simple_*`、`multi_*`、`creative_*`。任务 id 的第一个 `_` 前的前缀即为 complexity 分类。这个规范在注释中已提到，但代码没落实。

`TaskResult` 接口（第 80-93 行）只有 taskId，没有 complexity 字段。`BenchmarkTask`（第 26-35 行）有 `complexity: TaskComplexity`。

### 6.3 修改要求

在 `aggregateAblationResults` 函数中，利用 taskId 前缀推断 complexity：

```
"simple_*"    → TaskComplexity "simple"
"multi_*"     → TaskComplexity "multi_step"
"creative_*"  → TaskComplexity "creative"
其他           → 跳过（不计入 byComplexity）
```

填充 byComplexity 的4个字段：total、completed、correct、avgTurns。

**avgTurns 的计算：** 该 complexity 分类所有任务的 `turns.length` 平均值（分子为所有任务 turns 之和，分母为任务数，分母为 0 时返回 0）。

修改后，`aggregateAblationResults` 不改变函数签名，不改变返回类型。

### 6.4 同时新建测试

**路径：** `packages/agent/src/workspace/experiments/__tests__/ablation.test.ts`

**用例（3个）：**

1. **byComplexity.simple 正确聚合**：输入包含 2 个 simple 任务（一个完成，一个未完成），断言 byComplexity.simple.total=2，completed=1

2. **byComplexity.multi_step 正确聚合**：1个 multi_step 任务，completed=true，turns 有 3 个记录 → avgTurns=3

3. **未知前缀 taskId 不计入 byComplexity**：taskId="unknown_task" → byComplexity 所有分类的 total 都是 0

**构造最小 TaskResult：**
```typescript
function makeTask(taskId: string, completed: boolean, turnCount: number): TaskResult {
   return {
      taskId,
      config: { mode: "control" },
      completed,
      correct: null,
      turns: Array.from({ length: turnCount }, (_, i) => ({
         turnNumber: i,
         modelCallTokens: 100,
         toolCalls: [],
         workspaceSnapshot: 0,
      })),
      totalTokens: 100 * turnCount,
      totalDurationMs: 1000,
      errorCount: 0,
   };
}
```

### 6.5 验证命令

```bash
cd packages/agent
bun test src/workspace/experiments/__tests__
```

---

## 七、任务四：涌现分析增强

**文件：** `packages/swarm-extension/src/emergence-analysis.ts`

### 7.1 当前局限

`analyzeEmergence` 函数目前：
- 只能批处理整个 observation 日志，无法增量更新
- 收敛性判断只比较"最初5个 vs 最后5个快照"的方差，缺少相邻快照间的稳定性指标
- `ConceptStats.lifespanSeqs` 字段定义了但数据质量低（lastWriteSeq 在被驱逐前无法准确获取）

### 7.2 新增 Jaccard 相似度序列（必做）

在 `ConvergenceResult` 接口中新增一个字段：

```typescript
/** Jaccard similarity between consecutive snapshots (0=completely different, 1=identical). */
jaccardOverTime: Array<{ seq: number; jaccard: number }>;
```

在 `analyzeEmergence` 函数中，对 `occupancyTrace` 对应的快照数据计算相邻快照的 Jaccard 相似度：

```
Jaccard(A, B) = |A ∩ B| / |A ∪ B|
其中 A, B 是两个快照的 key 集合
```

实现要求：
- 只在有连续两个 snapshot 类型 observation 时才计算
- 结果附在 `jaccardOverTime` 数组（每个元素的 seq 取后一个快照的 seq）
- 如果快照数 < 2，jaccardOverTime 为空数组

### 7.3 同时新建测试

**路径：** `packages/swarm-extension/src/__tests__/emergence-analysis.test.ts`

**用例（5个）：**

1. **空 observations 返回零值报告**：调用 `analyzeEmergence([], null)` → observationCount=0，coreConcepts=[]，jaccardOverTime=[]

2. **单代理写读统计正确**：
   - observation 序列：write(agent1, key="file:a"), read(agent1, key="file:a")
   - 断言：agents[0].writeCount=1, agents[0].readCount=1, centrality.byReadership[0].key="file:a"

3. **coreConcepts 正确筛选**：
   - 2个 agent，概念 X 被两者都读 → coreThreshold=ceil(2*0.5)=1 → X 在 coreConcepts 中
   - 概念 Y 只被 1 个读 → readerCount=1 >= threshold=1 → Y 也在 coreConcepts（边界条件）

4. **broadcastConcepts 正确筛选**：概念 Z：writerCount=1，readerCount=2 → Z 在 broadcastConcepts；概念 W：writerCount=2 → W 不在 broadcastConcepts

5. **jaccardOverTime 计算正确**：
   - 快照1：keys=["a", "b", "c"]
   - 快照2：keys=["b", "c", "d"]
   - 期望 Jaccard = |{b,c}| / |{a,b,c,d}| = 2/4 = 0.5
   - 断言 jaccardOverTime[0].jaccard 约等于 0.5（允许浮点误差 ±0.001）

**构造 BusObservation 的辅助函数：**
```typescript
function makeWriteObs(seq: number, agentId: string, key: string): BusObservation {
   return {
      seq, agentId,
      timestamp: new Date(seq * 1000).toISOString(),
      type: "write",
      slot: { key, value: null, source: agentId, kind: "fact", importance: 0.5 },
   };
}

function makeReadObs(seq: number, agentId: string, key: string): BusObservation {
   return {
      seq, agentId,
      timestamp: new Date(seq * 1000).toISOString(),
      type: "read",
      slot: { key, value: null, source: agentId, kind: "fact", importance: 0.5 },
   };
}

function makeSnapshotObs(seq: number, agentId: string, keys: string[]): BusObservation {
   return {
      seq, agentId,
      timestamp: new Date(seq * 1000).toISOString(),
      type: "snapshot",
      snapshot: keys.map(k => ({ key: k, value: null, source: agentId, kind: "fact" as const })),
   };
}
```

### 7.4 验证命令

```bash
cd packages/swarm-extension
bun test src/__tests__/emergence-analysis
```

---

## 八、全量验证

所有任务完成后，在项目根运行：

```bash
# TypeScript 类型检查
bun run check

# 全部测试
bun test packages/agent/src/workspace
bun test packages/swarm-extension/src

# 如果有 CI 脚本
bun run ci:test:ts
```

期望：无类型错误，所有新测试通过，现有测试不退化。

---

## 九、编码规范提示

- 所有测试文件顶部 import 顺序：bun:test → node: → 内部包 → 相对路径
- 测试描述用英文，简洁描述行为（"returns empty array when no observations" 而非 "test1"）
- 每个 test() 内严格遵守 Arrange-Act-Assert 结构，用空行分隔三段
- 不使用 `mock.module()`，不使用文件级全局 mutable 状态（beforeEach 重置）
- 测试只覆盖外部可观察行为，不测试内部实现细节（不直接访问 #private 字段）
- 文件操作测试必须用 `fs.mkdtemp` + `afterEach` 清理，防止测试污染

---

## 十、任务优先级

| 优先级 | 任务 | 依赖 |
|--------|------|------|
| P0 | 任务一（workspace 单元测试）| 无 |
| P1 | 任务三（ablation bug 修复）| 无，可与 P0 并行 |
| P1 | 任务二（swarm 测试补全）| 无，可与 P0 并行 |
| P2 | 任务四（涌现分析增强）| 任务一、二完成后 |

任务一和任务三可以同时开始，任务四放最后。
