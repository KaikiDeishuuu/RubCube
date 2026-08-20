# RubCube 求解、回放与教程设计

> 本文是 [DESIGN.md](DESIGN.md) 的补充，覆盖三块功能：走子历史与回放、Kociemba 两阶段求解器、分层教学模式。
>
> DESIGN.md §2.1、§6.5 与 §8 给出目录、指标和粗粒度里程碑；本文把它们补齐到可实现的粒度。历史与教程扩展 §1.1 目标 A（人类可玩），其里程碑已经同步回主文，但不阻塞 benchmark v1。
>
> 本文中的状态空间与表大小来自明确的坐标基数推导；球层数量、表直径和公式保持性是实现必须复现的验收常数。M3a 的六张移动表和四张剪枝表已由穷举 oracle 固化，9/9/14/12 是当前实现复现的直径；M3b 搜索、M3c 最优搜索与 M3.5 教程仍未实现，不能把对应设计值提前写成实测结果。

---

## 0. 为什么是三个模块

"回到复原态"这件事有三种完全不同的含义，它们的实现、代价和用途都不一样。混为一谈是这个功能最容易走歪的地方。

| | 撤销（回放） | 求解 | 教学 |
|---|---|---|---|
| 问题 | 我刚才怎么走的？ | 怎样在预算内快速复原？ | 人该怎么想？ |
| 输入 | 走子历史 | 任意合法状态 | 任意合法状态 |
| 输出 | 从当前状态回到历史 checkpoint 的逆序 | 目标 ≤ 21 步；若预算内已找到首解，则保留 ≤ `hardMax`（默认 30）的当前最好解 | 分阶段、带解释、每个完整教学单元 ≤ 11 步 |
| 步数 | 与历史等长（可能几百步） | 通常 18–22；硬上限由 `hardMax` 决定 | 50–80 |
| 算法 | `invertMoves` | Kociemba 两阶段 | 分层法（LBL）+ 公式库 |
| 依赖 | 无（`cube-core` 已有） | 剪枝表 ~1.92 MiB（加移动表共 ~3.62 MiB） | 离线生成的约化策略表 + 判据 + 公式 |
| 实现量 | 1–2 天 | 数天 | 数天 |
| 可教性 | 无（是倒带） | **无**（见 §3.1） | 全部意义所在 |

**关键结论：Kociemba 的解不能拿来教学。** 它给出的约 20 步预算内快速解没有人类阶段语义——中间态既不是"第一层完成"也不是任何可命名的阶段，纯粹是坐标空间里的一条捷径。想教人复原，必须另写一个刻意更笨的求解器。这是 §3 存在的理由。

依赖关系：

```
cube-core (state / moves，默认入口只导出规则 API)
  ├── solver/        ← 模块二。通过 /solver 子路径导出；纯计算，无 DOM、无 Node API
  ├── tutorial/      ← 模块三。通过 /tutorial 子路径导出；只依赖规则 API
  └── metrics.ts     ← §6.5 的 progress_score，依赖 solver，只给裁判使用

app
  └── history        ← 模块一。baseState + commit-time reducer
```

模块三**不依赖**模块二，这是有意的：分层法自己就能解，引入 Kociemba 只会让它想抄近路。`solver`、`optimal`、`metrics`、`tutorial` 都不能从 `@rubcube/cube-core` 默认入口重导出；这个出口隔离同时服务于 §4 的评测防作弊。

---

## 1. 模块一：走子历史与回放

### 1.1 实施前基线（M2.5 已完成）

M2.5 开工前，[`resetCube`](packages/app/src/App.tsx#L279) 调 `renderer.replaceState(createSolvedState())`，而 `replaceState` 的语义是"取消所有进行中的动画、清空队列、原子换状态"——它是给外部灌状态用的通道，不走动画。

当时历史尚不存在：[`store.ts`](packages/app/src/store.ts) 里只有 `cube`（当前状态）、`scramble`（最后一次打乱的记号串）、`lastAction`（一行文字）。键盘走子走 [`playMoves`](packages/app/src/App.tsx#L200) 直接 `enqueue`，拖拽走子走 [`onStateChange`](packages/app/src/App.tsx#L151) 只更新文本，两条路都没有把 move 记到任何地方。现在 transport、历史 reducer、Undo、倒带和 fallback 等价路径均已接通；本节保留这段基线，用于解释后续状态机设计针对的原始缺口。

`cube-core` 已经有 `invertMove` / `invertMoves`，逆运算本身不用重写；工作重点是把 renderer/fallback 的 commit provenance 和 app 侧 reducer 接成同一条状态机。

### 1.2 权威模型：`baseState + commits`

**只在一步真正进入已提交 `CommitBatch` 后改变历史，不在 `enqueue` 里改变。** 历史不是一串 UI 请求，而是从一个 checkpoint 到当前权威状态的已提交事务日志：

```ts
type CommandIntent = 'forward' | 'undo' | 'rewind';
type MoveOrigin =
  | 'manual'
  | 'drag'
  | 'formula'
  | 'scramble'
  | 'tutorial'
  | 'auto-solve'
  | 'history';

interface CommitProvenance {
  readonly commandId: string;
  readonly intent: CommandIntent;
  readonly origin: MoveOrigin;
}

interface HistoryEntry {
  readonly move: Move;
  readonly origin: MoveOrigin;
  readonly commandId: string;
}

interface HistoryState {
  /** 最近一次 replace/reset/import 的深克隆状态；不假定它是复原态。 */
  readonly baseState: CubeState;
  readonly entries: readonly HistoryEntry[];
  readonly truncated: boolean;
}

interface QueuedMove {
  readonly move: Move;
  readonly provenance: CommitProvenance;
}
```

任意一次 move commit 后都必须满足下面的不变量，其中 `committedCubeState` 明确取当前 `change.state` 快照，绝不能重读已经领先到 batch 尾的 renderer/store live state：

```ts
statesEqual(
  applyMoves(history.baseState, history.entries.map((entry) => entry.move)),
  committedCubeState,
)
```

为此，renderer 的内部队列元素必须是 `QueuedMove`，不能只给整个 active group 挂一个 source；对面层并发提交时，每一步仍带回自己的 provenance。`enqueue(moves, provenance)` 给序列内每步复制同一 command，拖拽则在 `beginInteractive` 时生成一个 `forward/drag` command；`CubeStateChange` 对 move commit 原样带回 provenance，replace change 明确没有它。Undo/倒带使用 `history` origin。

transport 不逐项调用 app，而是按 DESIGN.md §4.4 交付一个 `CommitBatch`。app 的权威 reducer 在单次 Zustand transaction/draft 中按 `batch.changes` 顺序 fold 下面的规则，逐项用各自的 `change.state` 验证不变量，最后才把 `batch.finalState` 暴露给 UI。WebGL animator 与 fallback 只是两种 transport：二者都必须经过同一个 `CommitDispatcher`，继承 command registry、deferred FIFO、异常隔离、batch-final 和 `CommandEnd` 语义；fallback 不能直接调用 reducer，也不能一次 `applyMoves` 后另写历史。

commit reducer 的规则是：

- `forward`：把已提交 move append 到 `entries`
- `undo`：校验该 move 确实是当前最后一条的逆步，然后 pop 一条
- `rewind`：每提交一个逆步，校验并 pop 当前最后一条；整个命令结束时自然变为空，不提前 `clear`
- `replace`：取消旧命令的未提交后缀，令 `baseState = replacement`、`entries = []`、`truncated = false`

校验失败是程序错误，但当前 commit batch 在 transport 内已经完整落地，app 不能抛出帧循环或声称撤回它。整个 draft 作废，`CommitDispatcher` 走 `onDispatchError(event, error, latestCommittedState)`：以 `batch.finalState` 建一个诊断用 checkpoint 保住 cube/history 一致性、清 coordinator、让 active/queued/deferred 中所有已接受且未结束的 command 各收到唯一 `failed` end，然后进入 fatal invariant UI；只有显式 Reset/重载才能恢复。若失败的是已经派发的 `CommandEnd` handler，则不补第二个 end，保留先前成功提交的 cube/history。这样既不会留下半个 reducer 状态，也不会静默继续错误日志。

`CommitBatch.changes` 仍为每个逻辑 move 保留一步快照，所以这个模型继续满足三个目标：拖拽自动入历史；中途打断只留下已提交前缀；replace 是确定的 checkpoint。provenance 让 reducer 知道某次 commit 是普通前进、Undo 还是倒带，不会把 Undo 本身再次当成新历史。

### 1.3 四个动作，四种语义

**不要把这四个塞进一个按钮。** 用户点 Reset 的时候想要的是"给我一个新魔方"，让它花 4 秒演示倒带是帮倒忙。

| 动作 | 语义 | 实现 | 步数 |
|---|---|---|---|
| **Reset** | 给我一个新魔方 | `replaceState(solved)`，由 replace commit 建新 checkpoint | 0（瞬时，保持现状） |
| **Undo** | 撤销最后一个已提交 move | 空闲时 enqueue `invertMove(last.move)`，intent=`undo`；commit 时 pop | 1 |
| **倒带** | 回到当前 checkpoint | 空闲时 enqueue `invertMoves(entries.map(e => e.move))`，intent=`rewind`；逐 commit pop | 与历史等长 |
| **自动复原** | 展示求解器给出的快速解 | 空闲时处理 `SolveResult`，enqueue `moves/best`，intent=`forward` | 目标 ≤ 21，兜底 ≤ 30 |

Undo 是这里唯一的刚需——练习公式时没有 Undo 基本没法用。倒带是锦上添花。**"按解法一步一步拧回去"对应的是「自动复原」，不是 Reset**，它需要模块二。

### 1.4 边界情况

| 情况 | 处理 |
|---|---|
| 队列还在播时点 Undo / 倒带 | 两个按钮及其键盘路径都 disabled。逆步不能排到未知后缀之后；另设“取消播放”才负责丢弃未提交后缀，不把取消和撤销混成一个动作 |
| 历史为空点 Undo | 按钮 disabled |
| `fallback` 模式（无 WebGL） | `playMoves`、打乱、教程和自动复原都按 move 形成 batch，并把相同 provenance 送进共享 `CommitDispatcher`；Reset/import 形成相同 replace batch，不能直调历史 reducer。每个 move 后用 macrotask/下一帧让出并复查 cancel，不能同步耗尽整段 |
| 打乱 | WebGL 与 fallback 都先 replace solved，再以 `forward/scramble` 逐步提交最终展示的 scramble 序列；当前 random-move fallback 是 25 HTM，M3b 后的 random-state 序列长度由经验证的 solver 结果决定。所以打乱后倒带都回到 solved checkpoint |
| 历史无上限增长 | 上限 1000 条；丢最旧项时同时把该 move apply 到 `baseState` 以保持不变量，并置 `truncated`。Undo 仍可用，倒带 disabled，直到下一次 replace 建立完整 checkpoint |
| Undo/倒带动画失败 | 当前尚未进入 commit 的整组逆步零提交回滚；已提交 batch 中的逆步已经同步 pop。`CommandEnd.status` 为 `failed`，UI 显示中断并允许从一致前缀继续 |

中断语义不能省：倒带若只提交了一部分，UI 必须明确显示“已中断”并允许从当前一致状态继续，绝不能把它标成已经回到 checkpoint。

### 1.5 验收

- 用随机命令状态机跑至少 1000 轮；每个 batch 在同一 draft 中逐 change 验证 `applyMoves(baseState, entries.map(e => e.move))` 等于该 `change.state`，batch 尾等于 `finalState`；未截断时 `applyMoves(current, invertMoves(entries.map(e => e.move)))` 等于 baseState。注意 `invertMoves` 已经负责逆序，后面**不得再 `.reverse()`**
- Undo/倒带在 enqueue 后、首个 commit 前被 context loss / dispose 打断，状态和历史均不提前变化；每个成功 commit 后恰好 pop 一条
- 队列播到一半调 `replaceState(s)`：旧命令不再产生迟到 commit，随后 `statesEqual(baseState, s)`、历史为空；这条测试不拿 replace 前的回调总数和清空后的长度比较
- `transport.isBusy`（包括 WebGL/fallback 的教程演示命令）时，按钮、键盘和无障碍等价路径都不能发出 Undo/倒带命令；跟练模式两步之间的 Undo 作为错步/改路让 coordinator 从真实状态重算
- WebGL 与 fallback 对同一组**无中断**命令产生相同的 `baseState`、move/origin 序列、`CommandEnd` 状态和 `truncated`；覆盖普通公式、打乱、教程、自动复原、Reset、Undo 与倒带。取消/observer/reducer 抛错则分别在各 backend 的原子 batch 边界验证一致性不变量、唯一 end 和准确 `committedMoves`；不得把 WebGL 的双步并发 batch 与 fallback 的单步 batch 当成相同观察边界
- 并发只合并同 `commandId`；active group 在 commit 前取消时零 change，batch callback 内取消时保留当前 batch、丢弃后缀。每个 command 恰好一个 end 事件，且任何回调异常都不逃出帧循环
- 覆盖 `CommandEnd` observer enqueue 后、后续 replace batch reducer 抛错：deferred command 已被 accepted，必须收到唯一 `failed` end；空 enqueue 则不 accepted、不增 revision、无 end
- 超过 1000 条后仍保持 base+entries 不变量，`truncated` 时倒带不可用；下一次 replace 后恢复可用

---

## 2. 模块二：Kociemba 两阶段求解器

对应 DESIGN.md §8 的 **M3a–b**。已落地的 M3a 位于 `cube-core/src/solver/{constants,coordinates,tables,artifact,types}.ts`；M3b 将新增 `kociemba.ts`。k≤9 真最优搜索是 M3c，计划单独放在 `cube-core/src/optimal/bidirectional.ts`；当前只有 `/solver` package subpath 已导出，Node/bench-only 的 `/optimal` 尚未落地。

### 2.0 前置条件：中心块必须已归位

求解器的走法集合是 18 个面转，而**面转永远不动中心块**。玩家用 M/E/S 拧过之后，`state.centers` 可能落在 24 种整体朝向的任意一种；这时 `cp/co/ep/eo` 即使全部归位，六个面也不是单色的，而任何面转序列都无法把中心转回去。

因此 M3b 的入口必须先处理朝向，不能直接把任意 `CubeState` 喂给两阶段搜索：

1. 从 `state.centers` 求出整体朝向 `r`（24 选一，中心排布与朝向一一对应）。
2. 用 `r⁻¹` 把整个状态旋回标准朝向，再送进搜索。
3. 把解里的每个面字母按 `r` 重标号，得到在玩家当前朝向下可直接播放的解。

第 3 步不能省：在旋正后的坐标系里求出的 `R` 对玩家而言可能是 `F`。另一种等价做法是把目标态从"标准复原态"改成"`r` 作用后的复原态"，但那要改坐标与剪枝表的目标索引，代价远大于两次重标号。

打乱不受影响：`generateRandomMoves` 与随机状态打乱都只产出 `FaceMove`、只生成 `centers` 为恒等的状态（见 DESIGN.md §3.2），所以基准评测路径上 `r` 恒为单位元。

### 2.1 两阶段的思想

定义两个群：

- **G0 = ⟨U, D, L, R, F, B⟩**——所有 18 个走法，即整个魔方
- **G1 = ⟨U, D, L2, R2, F2, B2⟩**——只允许 U/D 任意转、其余四面只能转 180°

G1 里的状态有三个不变量：所有角块定向正确、所有棱块定向正确、中层四个棱块留在中层。G1 的大小是 `8! × 8! × 4! / 2 = 19,508,428,800`。

求解拆成两段：

1. **阶段 1**：从任意状态走进 G1（≤ 12 步）
2. **阶段 2**：在 G1 内部走到复原态（≤ 18 步）

分开之后每段的搜索空间都能用坐标压缩到可放剪枝表的规模，这就是全部的技巧。

### 2.2 坐标定义

**阶段 1**（目标坐标 = `(0, 0, 0)`）：

| 坐标 | 含义 | 基数 |
|---|---|---|
| `CO` | 角块定向，7 个自由（第 8 个由 `sum % 3 === 0` 定死） | 3⁷ = 2,187 |
| `EO` | 棱块定向，11 个自由（第 12 个由 `sum % 2 === 0` 定死） | 2¹¹ = 2,048 |
| `UDSlice` | 中层四棱占据了 12 个棱位中的哪 4 个，**不计顺序** | C(12,4) = 495 |

阶段 1 搜索空间 = 2,217,093,120。

**阶段 2**（固定枚举顺序缩到 U, U', U2, D, D', D2, L2, R2, F2, B2 共 10 个）：

| 坐标 | 含义 | 基数 |
|---|---|---|
| `CP` | 8 个角块的排列 | 8! = 40,320 |
| `UDEdgePerm` | 上下层 8 个棱块的排列 | 8! = 40,320 |
| `SlicePerm` | 中层 4 个棱块的排列（此时它们已在中层，只差顺序） | 4! = 24 |

三个坐标的笛卡尔积有 `40,320 × 40,320 × 24 = 39,016,857,600` 个组合，但其中只有一半满足角、棱排列同奇偶。阶段 2 的**合法状态数**因此是 `40,320 × 40,320 × 24 / 2 = 19,508,428,800`，与上面的 G1 群大小一致。后面的两张 pair 剪枝表仍各有 967,680 项：投影掉的另一个排列坐标总能补足奇偶性，不能再把 pair 表除以 2。

`cube-core` 的 `CubeState` 就是 `cp/co/ep/eo`，六个坐标全部是它的直接函数，不需要中间表示。

### 2.3 移动表

每个坐标 × 每个走法 → 新坐标，`Uint16Array` 存。

| 表 | 坐标数 × 走法数 | 条目 | 大小 |
|---|---|---|---|
| `CO` | 2,187 × 18 | 39,366 | 76.9 KiB |
| `EO` | 2,048 × 18 | 36,864 | 72.0 KiB |
| `UDSlice` | 495 × 18 | 8,910 | 17.4 KiB |
| `CP` | 40,320 × 10 | 403,200 | 787.5 KiB |
| `UDEdgePerm` | 40,320 × 10 | 403,200 | 787.5 KiB |
| `SlicePerm` | 24 × 10 | 240 | 0.5 KiB |
| | | | **1.70 MiB** |

阶段 2 的三张表只需要 10 个走法：阶段 2 的起始坐标直接从 cubie 状态算（把阶段 1 的解 apply 上去即可），不需要用 18 个走法追踪。

M3a 已冻结两层布局：移动表使用 `coordinate * moveCount + moveIndexWithinSet`；pair 表使用 `first * secondCount + second`。偶数 pair index 存低 nibble，奇数存高 nibble；奇数长度表未使用的尾部高 nibble 必须保持 `0xF`，公共读取 API 必须传逻辑 `entryCount`，不能把 padding 当成坐标。

### 2.4 剪枝表

每张表存"从这个坐标对到目标至少还要几步"，反向 BFS 生成。

| 表 | 条目 | 最大深度 | 打包 | 大小 |
|---|---|---|---|---|
| 阶段 1 `CO × UDSlice` | 1,082,565 | 9 | nibble | 528.6 KiB |
| 阶段 1 `EO × UDSlice` | 1,013,760 | 9 | nibble | 495.0 KiB |
| 阶段 2 `CP × SlicePerm` | 967,680 | 14 | nibble | 472.5 KiB |
| 阶段 2 `UDEdgePerm × SlicePerm` | 967,680 | 12 | nibble | 472.5 KiB |
| | | | | **1.92 MiB** |

这里的 9/9/14/12 是四个**坐标投影**的穷尽 BFS 直径；12/18 是完整阶段坐标的直径，不能拿来当 pair 表的最大值。首版每项存 4 bit，并保留 `0xF` 表示“尚未访问”，所以可表示的最大实际深度是 14。奇数项表向上取整到整字节。

经典实现还能只存 `depth mod 3`：生成时用 2 bit 的第四个值作空槽，生成完成后每项只保留 0/1/2。这样剪枝表可从约 1.92 MiB 再降到约 0.96 MiB，但查询不能把两位值直接当深度；必须先沿下降邻居恢复起点的真实下界，再利用一次走法只会令距离变化 -1/0/+1 来跟踪 DFS 中的真实值。首版先用 nibble，只有包体或常驻内存实测成为问题时才切 2-bit。

加上 1.70 MiB 的移动表，nibble 版本常驻内存约 **3.62 MiB**；若切 2-bit，约 **2.66 MiB**。

### 2.5 搜索

两层嵌套 IDA*，但“最多愿意搜索多长”和“找到多短就可以提前停”必须是两个参数。阶段上界只保证存在不超过 `12 + 18 = 30` 的两阶段解；21 是产品目标，不是完备性上界。

```ts
interface SolveOptions {
  /** 完备搜索的总长上限；默认 30。 */
  readonly hardMax?: number;
  /** 找到不长于此值的解即可提前成功；默认 min(21, hardMax)。 */
  readonly targetLength?: number;
  /** 确定性的主预算；阶段 1/2 每展开一个 DFS 节点都计数。 */
  readonly maxNodes?: number;
  /** 交互场景的墙钟保险丝，不作为 benchmark 的复现条件。 */
  readonly budgetMs?: number;
}

type SolveResult =
  | {
      readonly status: 'solved';
      readonly moves: readonly Move[];
      readonly targetMet: boolean;
      readonly nodes: number;
      readonly elapsedMs: number;
    }
  | {
      readonly status: 'budget-exhausted';
      readonly best: readonly Move[] | null;
      readonly reason: 'max-nodes' | 'deadline';
      readonly nodes: number;
      readonly elapsedMs: number;
    }
  | {
      readonly status: 'no-solution-within-hard-max';
      readonly nodes: number;
      readonly elapsedMs: number;
    }
  | {
      readonly status: 'cancelled';
      readonly nodes: number;
      readonly elapsedMs: number;
    };
```

搜索骨架：

```
solve(state, options):
  assertValidState(state)
  hardMax = options.hardMax ?? 30
  targetLength = options.targetLength ?? min(21, hardMax)
  maxNodes = options.maxNodes
  budgetMs = options.budgetMs
  assert(0 <= targetLength <= hardMax <= 30)
  best = null

  for d1 in h1(state) .. min(12, hardMax):
    for each 阶段1解 s1 of exact length d1:       # max(prune1a, prune1b)
      if cancelled: return cancelled
      if budget exhausted: return budget-exhausted(best)

      mid = apply(state, s1)
      limit2 = min(
        18,
        hardMax - d1,
        best == null ? +∞ : best.length - d1 - 1,
      )
      if limit2 < h2(mid): continue

      outcome = 阶段2 IDA*(mid, limit2)            # max(prune2a, prune2b)
      if outcome cancelled: return cancelled
      if outcome budget-exhausted: return budget-exhausted(best)
      if outcome found:
        candidate = s1 + outcome.moves
        if best == null or candidate.length < best.length: best = candidate
        if best.length <= targetLength: return solved(best, targetMet=true)

  if best != null: return solved(best, targetMet=false)
  return no-solution-within-hard-max
```

**实测补充：同一个魔方要在多个等价问题上同时搜。** 阶段 1 的三个坐标都是相对 U/D 轴定义的（角/棱定向、中层四棱），所以「同一个魔方在哪个物理轴上做 U/D」会显著改变阶段 1 的难度；魔方与它的逆也是难度差别很大的两个问题。本机 25 步随机打乱语料上的实测：

| 变体 | 最慢六例耗时 |
|---|---|
| 正向（基线） | 428 / 418 / 340 / 318 / 343 / 268 ms |
| 逆状态 | 52 / 105 / 20 / 0 / 45 / 29 ms |
| `x` 共轭 | 46 / 26 / 35 / 102 / 32 / 75 ms |
| `z` 共轭 | 34 / 46 / 6 / 15 / 18 / 16 ms |
| `y` 共轭 | 423 / 386 / 251 / 318 / 263 / 157 ms |

`y` 绕的正是 U/D 轴本身，阶段 1 看到的还是同一个问题，所以**不做 y 变体**。实现取 `{标准, x, z} × {正向, 逆向}` 共六个变体。

**广度是分级的，不是一上来就六路。** 六个搜索共享预算，任一答案的到达速率只有两路时的三分之一，直接六路会把中位数抬上去。实现先跑「正向 + 逆向」两路，**只有累计节点数越过 1,000,000（中位数解只用 631k）才把四个旋转变体加进来**——慢状态才需要广度，快状态不该为它付钱。

共轭必须是**重标号**而不是旋转：搜索入口本来就会把中心块转回原位，直接旋转会被它抵消。

**轮转片大小与调用方的 chunk 无关。** 让 chunk 影响轮转粒度，会使「暂停过几次」改变返回的解；分片固定，chunk 只决定何时把控制权交还。

**阶段边界的同层走法要在输出上消去。** 每个阶段内部禁止连续同层，但边界会重置这个过滤器，所以解会以 `R` 接 `R2` 的形式出现而不是 `R'`。消去在**候选成形时**做，长度比较用消去后的值——这让 `limit2` 的界略偏保守（可能剪掉一个消去后本可更短的阶段 2 尾巴），代价是偶尔错过更短解，永远不会给出错解；真最优是 M3c。

要点：

- 阶段 1 **枚举多个解而不是只取第一个**。先允许得到一个 22–30 步的可用解并保存为 `best`，再继续找更短解；预算耗尽时也不会把已经找到的解丢掉。
- `maxNodes` 是 benchmark 的主预算，同一状态、表版本、走法顺序和节点预算必须得到相同的状态、解与节点数。`budgetMs` 只给 app 防止低端设备长时间占用 Worker；给评测报墙钟时间时不能把墙钟截止条件同时当算法输入。
- `htm-v1` 走法遍历顺序固定为 `U U' U2 D D' D2 L L' L2 R R' R2 F F' F2 B B' B2`，阶段 2 从中稳定过滤出 10 个合法 move。求解器单独实现 canonical predicate：同一面不能连续；对面可交换，所以固定只保留 `U D`、`R L`、`F B`，剪掉反序。`faceAxis` / `oppositeFace` 可以复用，但 `generateRandomMoves` 的规则不同，不能直接复用它的 predicate。该规则在每一阶段内部使用；阶段边界先重置 previous face。若要跨边界剪枝，必须另行证明不会把一个 `d1 = 12` 的合法分割改写成被阶段 1 上限排除的 `d1 = 13`，不能直接套同一个 predicate。
- `dfs-expanded-v1` 的计数也要逐字定义：每次 iterative-deepening root 进入 DFS 计 1；每个通过 canonical filter 的 child 在启发式/goal 判定前计 1；被 canonical filter 拒绝的候选不计。若启用 2-bit PDB，恢复真实深度时每个邻居 probe 再计 1 个 node-equivalent。达到 `maxNodes` 后不再开始下一次计数操作，返回时 `nodes <= maxNodes`。表生成/加载不计入 solve nodes。
- DFS 的每个循环和剪枝表恢复过程都必须走这个预算计数器；时间/取消检查可以每 1,024 个计数单位做一次，避免每节点读时钟。搜索内核还要能在固定计数边界暂停并恢复；这不改变走法顺序、节点计数或 deterministic profile，只为 Worker 让出事件循环。

### 2.6 表从哪来

三个候选方案，**完成跨目标环境 P50/P95 实测前不预选 A 或 B**：

| 方案 | 首次求解代价 | 发布体积 | 复杂度 |
|---|---|---|---|
| A 打包成懒加载二进制资产 | 下载 + 解码；初始页面不下载 | 当前 Node 样本 gzip-9 2,402,838 B / Brotli-q6 1,925,387 B；部署包仍待测 | 构建期生成 + 资产版本校验 |
| B 首次在 Worker 生成，存 IndexedDB | 一次性生成；浏览器/移动端耗时待实测 | 无表资产，但仍有生成器代码 | 缓存失效、进度与失败回退 |
| C 每次启动都生成 | 每次都生成 | 无表资产 | 最简单，只留作开发/测试回退 |

按四张 pair 表逐项展开，朴素 BFS 约有 **5,709 万次坐标对转移**，即约 1.14 亿次移动表读取，另有约 89 万个移动表条目要生成。不能据此先写死“1–3 秒”：M3a 要在目标桌面浏览器、目标移动设备和 Node CI 上分别测冷生成、序列化、IndexedDB 写入、缓存命中加载和二进制资产解码。浏览器冷生成 P95 ≤ 3 s 且缓存路径可靠时选 B；> 5 s 时选 A；中间区间由实测包体和首次求解 UX 决定。

2026-08-17 的本机 Node 22 / WSL2 基线在 i7-9750H 上以三个独立冷进程得到：生成 851.36–884.85 ms（中位数 856.59 ms）、编码 82.40–85.59 ms（中位数 83.86 ms）、严格解码 70.91–75.09 ms（中位数 71.45 ms）。artifact 固定为 3,799,756 B，CRC32 为 `crc32:facd232e`，SHA-256 为 `319936a6f02b58d24c25340e29d08e313ee472656e22ac5acd742046130ba38c`；完整样本见 [`solver-tables-node-wsl2-2026-08-17.json`](packages/cube-core/benchmarks/solver-tables-node-wsl2-2026-08-17.json)。这只是单机 Node 证据，不替代浏览器、移动端、IndexedDB 和资产 I/O 的决策数据。

**硬性约束（DESIGN.md §2.1）：`cube-core` 不得 import 任何渲染或 Node 专属 API。** 所以持久化必须注入，不能让 `tables.ts` 自己去碰 IndexedDB 或 `fs`：

移动表是 `Uint16Array`，剪枝表是打包字节，所以缓存不能只约定“某段 `Uint8Array`”而不定义格式。构建资产与运行时缓存共用一个有版本的二进制契约：

```ts
export interface TableArtifact {
  readonly formatVersion: number;
  /** Wire 名保留兼容；值必须是 TABLE_FINGERPRINT，而非 SOLVER_FINGERPRINT。 */
  readonly solverFingerprint: string;
  readonly byteOrder: 'LE';
  readonly byteLength: number;
  readonly checksum: string;
  readonly bytes: Uint8Array;
}

export interface TableStore {
  load(key: string): Promise<TableArtifact | null>;
  /** 必须原子替换；不能让下一次 load 看见半份表。 */
  save(key: string, artifact: TableArtifact): Promise<void>;
}

export function generateSolverTables(
  options?: TableGenerationOptions,
): SolverTables;

export function loadTables(
  store?: TableStore,
  options?: LoadTablesOptions,
): Promise<SolverTables>;
```

当前 wire format 固定为 `RBCT` v1、`LE`，依次包含 10 个严格有序的 section descriptor；每个 descriptor 记录名称、元素位宽、条目数、offset 和 length。`Uint16Array` 一律用 `DataView` 按 little-endian 编解码，不能把宿主机原生字节序当文件格式。checksum 使用 `crc32:xxxxxxxx`，覆盖完整 artifact bytes；报告另存 SHA-256 用于跨工具复核。`loadTables` 必须核对 magic、版本、table fingerprint、固定总长、各段边界、checksum、move 目标值域、实际 PDB nibble 值域和 odd-tail padding；不匹配或损坏就整份丢弃并重建。写缓存失败只影响下次冷启动，不能令本次求解失败。

浏览器的 IndexedDB adapter 写在 app 的 Worker 入口，Node 的 `fs` adapter 写在 `bench`，测试传内存实现；这些环境 adapter 都不进入 `cube-core`。无论是否传 store，`loadTables` 都按 fingerprint 在当前进程/Worker 合并并复用同一个 in-flight Promise，避免并发请求重复加载或造表；不传 store 只是不做跨进程持久化。成功 Promise 保留到模块/Worker 生命周期结束，失败则删除以允许重试；首个调用拥有该生命周期的 store/progress options，所以 Worker 初始化只能有一个权威入口。共享 TypedArray 是 solver-owned 只读存储，消费者不得修改。adapter 的 `load/save` 必须自行设置超时并以 rejection 结束，不能用永不 settle 的 Promise 卡住 `ready()`。

`generateSolverTables()` 是同步 CPU 工作；`loadTables()` 的 Promise/microtask 只负责 I/O、合并和错误边界，并不会把冷生成自动搬离主线程。因此 app 仍必须遵守下一节的 Worker 边界。

### 2.7 Worker 边界

**浏览器 app 的求解与表生成必须在 Web Worker 里跑。** DESIGN.md §1.1 承诺“稳定 60fps”，几十到几百毫秒的同步搜索不能放主线程。`cube-core` 本身仍只提供平台无关的纯计算 API；Node `bench` 可在进程内调用，是否再放 `worker_threads` 由跑批并发策略决定。

```ts
// app 侧
const solver = createSolverClient(); // 内部起 Worker；每条消息有 requestId
await solver.ready({ onProgress: setTableProgress }); // load/generate 不计入 solve 预算

if (transport.isBusy) return; // 自动复原只从无未提交命令的状态启动
const revision = useCubeStore.getState().commandRevision;
const snapshot = cloneState(useCubeStore.getState().cube);
const result = await solver.solve(snapshot, {
  hardMax: 30,
  targetLength: 21,
  maxNodes: GAME_SOLVER_NODE_BUDGET,
  budgetMs: 300,
});

// 求解期间用户可能又转了一步、Reset 或重新打乱；旧解绝不能入新状态的队列。
if (transport.isBusy) return;
if (useCubeStore.getState().commandRevision !== revision) return;
if (!statesEqual(useCubeStore.getState().cube, snapshot)) return;

const moves =
  result.status === 'solved'
    ? result.moves
    : result.status === 'budget-exhausted'
      ? result.best
      : null;
if (moves !== null && moves.length > 0) {
  transport.enqueue(moves, {
    commandId: createCommandId(),
    intent: 'forward',
    origin: 'auto-solve',
  });
}
```

已复原输入会得到合法空解，但 `enqueue([])` 按 transport 契约是 no-op：不 accepted、不增 `commandRevision`、不产生 `CommandEnd`。调用方像上面一样直接跳过即可。

协议边界：

- 输入只有 `cp/co/ep/eo` 四个 `Uint8Array`，总共 40 字节。直接 structured-clone；**不能 transfer 调用方持有的 buffer**，否则 store/renderer 中的权威状态会被 detach。若将来确实要 transfer，也只能 transfer client 内部额外复制出的 buffer。
- `ready()` 负责资产加载或表生成，并报告 `loading-cache / generating / saving / ready` 及进度；只有 ready 以后才开始计算 `maxNodes` / `budgetMs`。缓存读取、写入或校验失败必须有明确 error/fallback。
- 新请求带递增 `requestId`，Worker 同时只运行一个 search；后来的 solve supersede 当前请求并令旧请求返回 cancelled。Reset、重新打乱或组件卸载也会发送 cancel。CPU 密集的同步 Worker 在搜索期间无法处理 `postMessage`，所以 Worker 不能用一个不让出的 `solve()` 假装支持取消：它每个固定节点 chunk 运行可恢复搜索，然后用 macrotask 让出事件循环，处理 cancel/新请求后再继续。Promise microtask 不足以让 message task 插队；若将来改用 `SharedArrayBuffer + Atomics`，必须把 cross-origin isolation 作为显式部署前提。Node 直调可以同步连续运行同一批 chunk；只有固定 `maxNodes`、不设 `budgetMs` 且不取消时，才要求 Node 与 Worker 的 moves/status/nodes 完全一致。deadline 会包含浏览器让出开销，只验证 SLA 与返回契约，不做逐结果一致性断言。
- `commandRevision` 覆盖所有会改变命令时间线的公共调用：任意 intent 的 enqueue（含 Undo、rewind、tutorial、auto-solve）、拖拽开始、replace 和 cancel。调用若发生在 commit callback 中，在它被接受进 deferred FIFO 时就递增，而不是等实际启动；主线程收到求解结果时同时检查 idle、revision 和状态快照，不能只信 cancel 的时序。
- `TableStore` 是函数接口，不能通过 `postMessage` 注入。app 的 Worker 模块在 Worker 内构造 IndexedDB adapter；若方案 A 由主线程取资产，则只通过消息传 `TableArtifact` 数据。
- 取消返回 `status: 'cancelled'`；预算耗尽和“长度上限内无解”使用各自的 `SolveResult` 分支。非法状态、表损坏和 Worker transport 故障以带 `requestId` 的 typed error 拒绝 promise。四者不能折叠成空 move 数组；空数组只表示输入本来已复原。

包入口也要隔离：Kociemba 纯计算从 `@rubcube/cube-core/solver` 导出，Node-only 的最优求解器从 `@rubcube/cube-core/optimal` 单独导出；两者都不从 app 常用的 root barrel 再导出。生产构建加断言，浏览器 chunk 中不得出现 `optimal` 模块或 Node adapter。

### 2.8 最优解（k ≤ 9）

DESIGN.md §6.5 要 `optimality_ratio`，其中“k≤9 用真最优解”。实现选双向搜索（meet in the middle），不用 IDA*。这不是因为 IDA* 在正确性上必须有大 PDB——任意 admissible 下界甚至 0 都能保证最优——而是双向搜索在这个固定深度上有更小、更可预测的工作量。完整角块 PDB 有 `8! × 3⁷ = 88,179,840` 项，nibble 是约 42.05 MiB；为只做到 k≤9 不值得引入。

当前 HTM 走法下，按完整 `CubeState` 去重后的精确层大小是：

| 距复原深度 | 0 | 1 | 2 | 3 | 4 | 5 |
|---|---|---|---|---|---|---|
| 恰好该深度的状态数 | 1 | 18 | 243 | 3,240 | 43,239 | 574,908 |

因此从复原态 BFS 到深度 4 的闭球是 **46,741** 个状态；深度 5 的闭球是 621,649 个状态。实现步骤：

1. 一次性从复原态 BFS 到深度 4。每个条目保存无碰撞状态键、精确深度、父条目和父 move。
2. 对待求状态做反向 iterative deepening DFS，深度依次为 0..5，并使用与 §2.5 相同的 canonical move 过滤。每访问一个状态就查前向表。
3. 记待求状态的真实最短距离为 `d*`。若 `d* ≤ 4`，深度 0 就直接命中；若 `5 ≤ d* ≤ 9`，任何少于 `d* - 4` 步的反向路径都不可能进入半径 4 的球，而一条最短路径在 `d* - 4` 步后必然进入；所以最早命中的迭代给出的就是真最优长度。
4. 若反向路径是 `scrambled → meet`，表中的父路径是 `solved → meet`，结果为 `backwardPath + invertMoves(forwardPath)`。最终仍用 `applyMoves` 独立验证。

“哈希表”不能暗含允许碰撞：完整魔方状态需要超过 64 bit 的无损编号。要么使用无损的多 word key，要么哈希命中后比较保存的完整 packed state。DFS 可用当前路径防环和跨迭代去重优化，但任何优化都不得剪掉某个深度内的 canonical 路径。

验收语料里的 `k` 是生成打乱的步数上限，只保证 `d* ≤ k`，不保证真实距离恰好等于 k；求解器返回的是状态本身的 `d*`。该模块只从 `@rubcube/cube-core/optimal` 暴露给 Node `bench`，并由 §2.7 的 bundle 断言保证不进浏览器包。

### 2.9 验收

| 项 | 标准 |
|---|---|
| 坐标与表 | 所有坐标满足 `encode(decode(i)) === i`；每张移动表对所有条目、所有合法走法与 cubie `applyMove` 一致；四张 BFS 的最大深度固定为 9/9/14/12 |
| 二进制契约 | 所有表做 artifact round-trip 后逐字节一致；错误 magic/version/fingerprint/length/checksum、截断文件和半写缓存都被拒绝并重建 |
| 正确性 | 固定 seed `0x52554243` 生成 10,000 个均匀合法状态；`hardMax=30`、固定 `BENCH_SOLVER_NODE_BUDGET`、不设 `budgetMs`，必须全部返回 `solved`，且 `applyMoves(s, result.moves)` 复原、输入四个数组未改变 |
| 返回契约 | 覆盖复原态空解、上限内无解、预算在首解前/后耗尽、取消以及非法状态；这些结果不能互相冒充 |
| 确定性 | profile 固定 `hardMax`、`targetLength`、`maxNodes`、canonical move order、节点计数版本和 solver/table fingerprint；不设 `budgetMs`、不取消时重复 10 次，moves、status、nodes 完全一致，Node 直调与 Worker 也一致（elapsed 除外）。deadline/cancel 只验证状态分支与不变量 |
| 解长度 | 在上述固定 10,000 状态语料与配置上，中位数 ≤ 20、P99 ≤ 22，并同时报告 `targetMet` 比例；不得只统计成功或短解子集 |
| 热路径速度 | 声明 CPU、浏览器/Node 版本和电源模式；表已 ready、JIT 预热后，纯求解 P50 < 50 ms、P99 < 300 ms。另报 Worker 往返 P50/P99，不把 300 ms deadline 截断后的样本当作“<300 ms” |
| 冷路径速度 | 分开报告生成、校验、序列化、缓存写入、缓存命中加载和资产解码的 P50/P95；以 §2.6 的门槛决定 A/B |
| Worker | caller 的四个 buffer 求解前后均未 detach；ready 前请求、并发请求、cancel、Worker error、IndexedDB 失败及求解期间 revision 改变都有集成测试，陈旧结果不会 enqueue |
| 最优解 | 先断言 BFS 精确层数 1/18/243/3,240/43,239/574,908；固定 seed 为每个 k=1..9 生成同量语料，结果必须复原且不长于原打乱。k≤6 与独立 BFS oracle 逐例一致；k=7..9 的固定样本再与 test-only 独立 IDA* 或可信参考实现逐例一致，不能只用“≤打乱长度”冒充最优性证明 |
| 距离代理 | 使用 DESIGN.md §9 的唯一 M3d manifest：固定三类语料、seed、完整 solver profile、solver/table fingerprint、最低 coverage 与 go/no-go 阈值；统一报告 Spearman ρ、MAE、逆序率、最短解方向一致率和 Lipschitz 违规率。随机游走只作对照；失败则整体切换指标版本，不逐样本混用 PDB |
| 代码覆盖率 | ≥ 90%（沿用仓库标准；不要和 M3d 的有效 proxy coverage 混淆） |

**M3b 首版实测（`packages/cube-core/scripts/benchmark-solver-search.mjs`，参数与语料都写死在脚本里，不能事后调）。** Intel i7-9750H / WSL2 / Node 22.23.2，1,000 个 25 步随机打乱（seed 0–999），50 次预热：

| profile | 语料 | 解长 P50 / max | targetMet | 求解 P50 / P95 / P99 / max | 节点 P50 / P99 |
|---|---|---|---|---|---|
| `targetLength=21` | 1000 | 21 / 21 | 100% | 24.5 / 143 / **251** / 890 ms | 631k / 6.2M |
| `targetLength=20` | 100 | 20 / 21 | 99% | 78 / 741 / 2240 / 4804 ms | 1.8M / 46M |
| `targetLength=19` | 40 | 19 / 21 | 77.5% | 396 / 6133 / 7087 / 7799 ms | 7.7M / 143M |

**热路径速度这一项在 `targetLength=21` 下达标（P50 < 50、P99 < 300），但「解长度」一项不达标：中位数是 21 而不是 ≤ 20。** 两条准则在当前表集下互相拉扯——把 target 压到 20 才能让中位解长达标，而那时 P99 是 2.24 s。要同时满足需要更强的剪枝（对称约简的 flipudslice 表），那会改动 M3a 已冻结的表规格，因此留作后续决策而不是悄悄改判标准。

另外，分级广度改善了 P95/P99，却让**绝对最坏例变差**（最坏 890 ms / 19.0M 节点，两路时是 687 ms / 15.0M）：越过阈值后本来就慢的状态要为额外四路买单。app 侧用 `budgetMs` 兜住这一类。

完整 profile（含 `hardMax` / `targetLength` / `BENCH_SOLVER_NODE_BUDGET` / move order / 节点计数版本）、语料数量、seed、参考硬件说明和 solver/table fingerprint 都提交进仓库，报告里原样输出，不能跑完以后按结果调预算。墙钟 `budgetMs` 只用于 app SLA；benchmark 若要比较耗时，算法输入仍保持固定节点预算。

最优解校准与距离代理验证都不是走过场。M3d profile 如果不过预注册门槛，§6.5 的核心指标就整体换成 PDB 下界或新的组合指标；**建议 M3b 一有可运行基线就立刻跑验证**。

---

## 3. 模块三：分层教学（LBL）与教程模式

### 3.1 为什么必须另写一个求解器

Kociemba 的解是**坐标空间里的捷径**。它的第 7 步做了什么？没有答案——那一步既不完成任何可命名的结构，也不服务于任何人类能复述的目标。把预算内快速解逐步播给用户看，用户学到的是“记住这次约 20 步”，而序列换个打乱就完全不同。

分层法（Layer-by-Layer）刻意更笨：50–80 步，但每一步都属于七个有名字的阶段之一，每个阶段只有 1–2 条公式，而且**一个完整教学单元提交后，后面的阶段不会破坏前面的成果**。公式中间的单个面转可以暂时拆开已经完成的结构；教程只在整段结束后推进阶段。这个事务边界和最终保持性是可教性的来源，下面 §3.3、§3.6 会把它变成可执行契约。

### 3.2 七个阶段与它们的判据

用 `cube-core` 的 Kociemba 表示（`CORNER_NAMES` = URF UFL ULB UBR DFR DLF DBL DRB，`EDGE_NAMES` = UR UF UL UB DR DF DL DB FR FL BL BR），**七个阶段的完成判据全是一行**：

| # | 阶段 | 槽位 | 判据 |
|---|---|---|---|
| 1 | 底面十字 | DR DF DL DB = 棱 4–7 | `ep[p] === p && eo[p] === 0` |
| 2 | 底层角块（第一层完成） | DFR DLF DBL DRB = 角 4–7 | `cp[p] === p && co[p] === 0` |
| 3 | 中层棱块（前两层完成） | FR FL BL BR = 棱 8–11 | `ep[p] === p && eo[p] === 0` |
| 4 | 顶面十字（顶棱定向） | UR UF UL UB = 棱 0–3 | `eo[p] === 0` |
| 5 | 顶面单色（顶角定向） | URF UFL ULB UBR = 角 0–3 | `co[p] === 0` |
| 6 | 顶层角块归位 | 角 0–3 | `cp[p] === p` |
| 7 | 顶层棱块归位（复原） | 棱 0–3 | `ep[p] === p` |

阶段 4 能写成 `eo[p] === 0` 是因为 `cube-core` 用的是标准 EO 约定。实测确认：

```
U: eo 翻转 0 个    D: 0    L: 0    R: 0    F: 4    B: 4
```

**只有 F/B 的 90° 转动会改变棱块定向。** 在这个约定下，位于 U 层的棱块 `eo === 0` 等价于它的顶色贴纸朝上——也就是"顶面十字"。

> **判据只在阶段序下成立。** `eo[0..3] === 0` 的字面含义是"目前占据 U 层四个槽的棱块是正定向的"，它等于"顶面十字"的前提是 U 层槽里装的确实是 U 层棱块——只有阶段 3 完成后才保证。别把这些判据当成独立谓词到处用。

因此公共语义不是“第 k 行单独为真”，而是前缀合取：

```ts
stageCompleted(state, k) = predicate1(state) && ... && predicateK(state)
currentStage(state) = 第一个不满足的前缀；七个前缀都满足时为 null
```

后续的保持性、ranking 和验收一律调用 `stageCompleted`，不直接拿一行局部判据冒充阶段完成。

### 3.3 保持性阶梯

每条公式在复原态上跑一遍，看它实际扰动了哪些槽位（实测）：

| 公式 | 服务阶段 | 扰动角块 | 扰动棱块 | 破坏第一层 | 破坏中层 |
|---|---|---|---|---|---|
| `U R U' R' U' F' U F` 中层右插 | 3 | UFL ULB UBR | UR UF UL UB **FR** | 否 | 是（正是目标槽） |
| `U' L' U L U F U' F'` 中层左插 | 3 | URF ULB UBR | UR UF UL UB **FL** | 否 | 是（正是目标槽） |
| `F R U R' U' F'` 顶面十字 | 4 | URF UFL ULB UBR | UR UF UB | 否 | 否 |
| `R U R' U R U2 R'` Sune | 5 | URF UFL ULB UBR | UR UL UB | 否 | 否 |
| `R' F R' B2 R F' R' B2 R2` A-perm | 6 | URF ULB UBR | **（无）** | 否 | 否 |
| `R2 U R U R' U' R' U' R' U R'` U-perm | 7 | **（无）** | UR UF UL | 否 | 否 |

表中公式都以 F 为教学正面写 canonical 版本。阶段 3 必须为中层左右插生成四个绕 U 轴重命名侧面字母的版本，分别只扰动目标 `FR/FL/BL/BR` 中层槽；完整单元是最多 1 个 `U/U2/U'` 调整加 8 HTM 公式，因此 ≤9。不能拿字面上的 FR/FL 两条公式冒充四个槽都已覆盖。

三条结论，都是可教性的支柱：

1. **没有一条公式破坏第一层。** 阶段 1–2 一旦完成就永久成立。
2. **Sune 保持棱块定向**——不是巧合，是结构性的：它只含 R 和 U，而 `eo` 只在 F/B 的 90° 转动上改变。所以阶段 5 不可能破坏阶段 4。
3. **裸 A-perm 是纯角块三循环（零棱块扰动），裸 U-perm 是纯棱块三循环（零角块扰动）。** 这解释了阶段顺序为什么必须是"先定向后归位"：Sune 会打乱顶层棱块排列，所以它必须排在阶段 6、7 之前。

第三条只对**裸公式**成立，而且 A-perm 单独还不完备：三循环是偶排列，只能生成 `A4`；阶段 5 之后完全可能出现“顶角奇排列 + 顶棱奇排列”的合法 PLL 状态。阶段 6 的离线 policy 因此使用 `U^k`（`k = 0..3`，非零时算 1 HTM）加裸 A-perm 作为动作；`U` 是角、棱各一个奇 4-cycle，和 A-perm 一起生成全部 `S4` 顶角排列。调整步会扰动顶棱，但保持所有定向及前三层已完成结构，正好把全局奇偶性带到阶段 7。每个含公式的完整单元最多 `1 + 9 = 10 HTM`；若仅一个 `U/U2/U'` 就能对齐角块，则返回 adjustment-only step。生成器必须穷举 24 个顶角排列（包括 12 个奇排列），证明都能在最多 2 个教学单元内到 `cp[p] === p`，不能只测复原态上的裸公式。

阶段 6 完成后，顶角排列已是偶排列，所以由整颗魔方的奇偶约束可知剩余顶棱排列也必为偶排列，U-perm 三循环足以生成并解决它。此时阶段 7 不能在 U-perm 前留一个未抵消的 `U` 调整——那会把四个顶角重新转走。公式库为 U-perm 预生成四个绕 U 轴重命名侧面字母的变体（例如把 R/F/L/B 循环映射），而不是在运行时添加 U setup。每个变体仍是 11 HTM、零角块扰动；反向三循环分成连续两个教学单元，每个仍 ≤ 11。生成器穷举 12 个偶顶棱排列并证明最大 policy 距离 ≤2 单元。若实现选择 `U^k + alg + U^-k` 共轭，也能保持角块，但会达到 13 步，违反本文的单元长度上限，不能和当前契约混用。

保持性测试的对象必须是 case classifier 最终返回的完整 `step.moves`，包括调整步和旋转变体；只测试上表的裸公式不够。

**整个初学者方法只需要 6 条公式**（中层左右插互为镜像，实际记 5 条）。这是教程的卖点，值得直接写进 UI 文案。

### 3.4 直觉阶段 vs 公式阶段

不是所有阶段都该用公式教。

| 阶段 | 教法 | 求步方式 |
|---|---|---|
| 1–2 底面十字、底层角块 | **直觉** | 离线生成的小型策略表；每次锁住正确块并放好一个确定目标，实测最大深度必须 ≤ 8 |
| 3–7 中层及顶层 | **公式** | 确定性情形表 → 具名公式 + 安全调整/旋转变体 |

阶段 1–2 现实中就是靠直觉教的，没人背公式放白色十字。给它配一个目标块策略 + "把这个棱块放到蓝色中心下面"的高亮和旁白，比硬塞一张 24 情形表更接近真人教学。阶段 3–7 反过来——那些公式本来就有名字，人就是这么记的。

直觉阶段不能只约束“已完成阶段”，否则阶段 1 没有任何约束，搜索可以刚放好一条十字棱又拆掉它。规则改为：

1. 每个阶段有固定目标顺序：十字为 `DR, DF, DL, DB`，底角为 `DFR, DLF, DBL, DRB`。
2. step 开始时，本阶段所有已经在正确槽位且定向正确的目标都是 `locked`；目标是固定顺序里第一个未锁定项。
3. step 的最终状态必须保持所有较早阶段和全部 `locked`，并把目标加入 locked。允许公式中间暂时移动它们，但完整 step 结束时必须恢复。
4. `locked` 是从传入状态重算的，不是教程模块保存的进度。因此用户绕路放好的块也会被尊重。

运行时不做深度 8 的朴素 BFS。构建期在“目标块 + locked 块”的约化坐标上反向 BFS，生成不可变策略表，并穷举证明每个可达坐标都有 ≤ 8 HTM 的下一步。表生成若发现反例就让构建失败，先调整目标顺序/深度上限，不能把 lookup miss 当成“已复原”。浏览器里的同步 `nextStep` 只查表，预期亚毫秒级；开发期若保留在线搜索器，它必须有节点预算并只在 Worker 中通过异步调试 API 使用，不能进入主线程产品路径。

为保证同一阶段内也不会循环，定义词典序 ranking：

```ts
tutorialRank(state) = [completedStagePrefix, -remainingUnitsInCurrentStage]
```

已复原态没有 current stage，固定使用 sentinel `[7, 0]`。比较必须逐项做数值词典序比较（先比第 0 项，相等再比第 1 项），不能对 JavaScript 数组直接使用 `>`；下文的 `rankAfter > rankBefore` 都是这个比较函数的简写。

阶段 3 沿用同一纪律：固定目标顺序 `FR, FL, BL, BR`，锁住所有已经正确的中层棱，插入或弹出目标时不得在完整 step 后破坏其它 locked 棱。某条错误中层棱可能要先弹到顶层，再用下一单元插入；第一单元不会增加 locked 数，所以不能把 `remainingUnits` 简化成“未锁定块数”。阶段 1–7 的确定性 policy 都在生成时记录沿选定策略到阶段完成还需多少个教学单元，且每条边严格减少该距离。任意非空 `nextStep` 完整执行后，rank 必须严格增加。这个比“已完成阶段数不减少”更强，并给出了终止证明。

### 3.5 契约

```ts
type StageId = 1 | 2 | 3 | 4 | 5 | 6 | 7;
type CubieRef =
  | { readonly kind: 'corner'; readonly name: CornerName }
  | { readonly kind: 'edge'; readonly name: EdgeName }
  | { readonly kind: 'center'; readonly face: Face };
type SlotRef =
  | { readonly kind: 'corner'; readonly name: CornerName }
  | { readonly kind: 'edge'; readonly name: EdgeName }
  | { readonly kind: 'face'; readonly face: Face };

type AlgorithmId =
  | 'middle-right'
  | 'middle-left'
  | 'yellow-cross'
  | 'sune'
  | 'a-perm'
  | 'u-perm:r'
  | 'u-perm:f'
  | 'u-perm:l'
  | 'u-perm:b';

interface TutorialStep {
  readonly stage: StageId;
  /** 一个可教的最小单元：调整步 + 公式。不是整个阶段。 */
  readonly moves: readonly Move[];
  /** step 含公式时是稳定的公式/变体 ID；直觉或 adjustment-only step 是 null。 */
  readonly algorithm: AlgorithmId | null;
  /** 要跟踪的物理块；是领域引用，不泄漏 renderer ID。 */
  readonly focus: readonly CubieRef[];
  /** 目标槽位/面，和稳定块身份分开表达。 */
  readonly targets: readonly SlotRef[];
  /** 情形标识，给文案查表用（'yellow-cross:dot' / 'f2l:edge-flipped'） */
  readonly caseId: string;
}

/**
 * 当前该做什么。已复原返回 null；其余合法状态必须返回 moves 非空、
 * 长度 ≤ 11 的确定结果。策略表缺项抛 TutorialInvariantError，绝不返回 null。
 */
export function nextStep(state: CubeState): TutorialStep | null;

/** 当前处在哪个阶段（第一个判据不成立的阶段）。 */
export function currentStage(state: CubeState): StageId | null;

/** 可比较的词典序 rank；只用于断言、调试和测试。 */
export function tutorialRank(state: CubeState): readonly [number, number];

/** 数值词典序；返回负数、0、正数。 */
export function compareTutorialRank(
  left: readonly [number, number],
  right: readonly [number, number],
): number;
```

### 3.6 无状态，每一步都从当前状态重算

**教程模块不持有会话状态。** 不可变策略表不是用户进度；`nextStep(state)` 是确定性纯函数，每次从当前 `CubeState` 重算阶段、locked 集、情形和下一步。同一合法 state 必须返回结构深相等的结果，不能随机打破并列。

这不是洁癖，是把一整类 bug 消掉：用户可以在教程进行中拖拽乱转、在 transport idle 的两步之间按 Undo、重新打乱、切到自由模式再切回来——教程永远给出对当前状态正确的下一步，因为它压根不记得刚才发生过什么。想不出任何需要教程持有进度的场景。

跟练和演示仍需要一个 **app 侧 step coordinator**。它保存 `{ mode, stepId, step, startState, cursor, demoCommandId? }`，但这不是求解器进度；跟练的 manual/drag 每步各有自己的 commandId，只有演示整段共享 `demoCommandId`：

- `TutorialStep` 是 **step completion boundary**，不是可回滚的数据库事务：其中每个 move 仍独立持久 commit；中断保留真实前缀，是一个小型 saga
- coordinator 一次消费整个 `CommitBatch.changes`，按顺序核对并推进 cursor，但扫描 batch 中途绝不调用 `nextStep`。到 batch 尾才基于 `finalState` 做完成/错步判定
- cursor 到末尾后，断言最终状态等于 `applyMoves(startState, step.moves)`、较早阶段仍完成且 rank 严格增加，再生成下一 step；演示还必须等对应 `CommandEnd.status === 'completed'`
- 跟练模式中只有 `manual` / `drag` origin 可以匹配并推进 cursor，并禁用公式批量提交；一次只接受一个未提交 move，该 move commit 或收到零提交 `CommandEnd` 前，键盘、拖拽和无障碍等价入口不再 enqueue 后缀。idle 时仍允许 `history` origin 的 Undo，但它立即使当前 saga 失效；Reset、scramble 和 replace 也只会失效/重建教程，不参与 cursor 匹配，模式切换则销毁 coordinator 并清高亮。出现不匹配或外部 timeline change 时不回滚用户动作；等 transport idle 且 `commandRevision` 稳定后，再从 batch `finalState` 重算并更新提示
- 演示时锁住其它转层输入，以带 `demoCommandId` 的一次队列命令播放完整 step；context loss、replace、`cancelPlayback` 或 `failed/cancelled` command end 导致的部分提交不算 step 完成，等 idle 后从最后一个 batch 的真实 `finalState` 重算

这个边界避免在公式中途暂时拆开第一层时，UI 错误地把教程回退到早期阶段；历史模块仍在同一个 batch draft 内按每个 move 记录，两者的粒度并不冲突。

### 3.7 渲染层要加的高亮 API

`cube-render` 目前每个 cubie 有独立 material（26 个），因此给物理 cubie 着色不需要拆 mesh，也不增加 draw call；它仍有 uniform 更新和额外片元运算成本，不能称为零成本。26 个 material 继续共享同一个 shader program cache key。

`CubieRef` / `SlotRef` 属于规则领域，不能反向引用 `cube-render` 的 `CubieDescriptor.id`。app adapter 用当前 layout 把物理块解析成稳定 mesh id、把槽位解析成整数位置，再调用渲染 API：

```ts
// CubeVisualSet 新增；这里只接受渲染层自己的类型
setTutorialHighlight(
  highlight: {
    readonly focusCubieIds: readonly string[];
    readonly targetSlots: readonly GridPosition[];
    readonly dimOthers: boolean;
  } | null,
): void;
```

物理块高亮的首版给每个 material 增加 `rubCubeHighlight` / `rubCubeDim` uniform，用 tint、emissive 或基于视角的 Fresnel 边缘提亮表达 focus，并按需压暗其余块。注入可复用现有贴纸 shader 的 `onBeforeCompile` 管线，但要新增稳定的 shader 锚点测试。真正的屏幕空间轮廓通常需要额外几何或 post-process pass，会增加 draw call/显存带宽，不作为首版默认方案。

`SlotRef` 表示一个空间目标，不等于当前占据该位置的 cubie，不能只改现有 cubie material 来冒充目标槽。WebGL 首版用轻量 marker/overlay 在 `targetSlots` 处画半透明框、角标或落点提示；marker 的额外 draw call 必须纳入移动端帧预算。fallback adapter 用相同的 `CubieRef` / `SlotRef` 分别高亮当前贴纸和目标槽位，不能丢掉任何教学信息。清空、切模式、取消 step 和 context recovery 都调用 `setTutorialHighlight(null)`，避免残留提示。

### 3.8 三种模式

| 模式 | 行为 |
|---|---|
| **跟练** | 显示当前阶段、目标块/槽位高亮、公式记号；一次只接受一个未提交 move；正确前缀继续，完整 step 后才推进，转错后等 idle/revision 稳定再从真实状态重算 |
| **提示** | 平时不出现，点一下给一步 |
| **演示** | 以单个带 provenance 的命令播放 `step.moves`，期间锁住其它转层输入，完整 commit 后再推进 |

三种共用同一个 `nextStep`，只是谁来执行 moves 的区别。

### 3.9 验收

| 项 | 标准 |
|---|---|
| 完备性 | 构建期穷举直觉阶段约化坐标和阶段 3–7 全部 case policy；另用 10,000 个种子随机合法状态做端到端验证。循环设显式 step/move 上限并检测重复状态，不能让测试挂死 |
| 步数 | 总步数中位数 ≤ 80，P99 ≤ 120 |
| 单元边界 | 所有未复原合法状态都返回 `1..11` 个 move；完整 step 后较早阶段前缀不减少且 `compareTutorialRank(after, before) > 0`，最终 solved rank 固定为 `[7, 0]`。阶段 3 左右插的四个侧面旋转逐个证明只扰动目标中层槽且单元 ≤9。阶段 6 穷举全部 24 个顶角排列并单列 12 个奇排列，最大 policy 距离 ≤2 单元、含 A-perm 单元 ≤10。阶段 7 穷举 12 个偶顶棱排列、最大距离 ≤2；U-perm 四个旋转变体逐个验证零角块扰动和长度 11 |
| 判据 | 七个判据在复原态上全部成立；每个判据都有针对性的反例测试 |
| 确定性 | 同一个 state 调 `nextStep` 两次，结果结构深相等；输入 state 不被修改，返回数组不可被外部改写 |
| 失败语义 | 策略 lookup miss / rank 不增加抛 `TutorialInvariantError`；只有复原态返回 null |
| 性能 | `/tutorial` 进入教程时懒加载；报告 generated policy 的 raw/gzip 大小与目标移动设备冷加载 P50/P95，P95 必须 < 500 ms，超出则按阶段拆 chunk。加载后 `nextStep` P99 < 2 ms；产品主线程不运行 BFS。Worker 调试搜索有节点/时间预算和明确超时错误 |
| 中断 | 跟练最多一个未提交 move；每次 drag 恰好一个 end（成功 `completed/1`，回弹/lost capture/cancel `cancelled/0`，故障 `failed/0`）。正确前缀不触发阶段重算；Undo、错步、replace、取消和 context loss 后等 idle/revision 稳定，再从最后已提交状态确定性恢复，部分 step 不被标成完成 |

---

## 4. 与评测的隔离

DESIGN.md §1.2 的非目标里有一条："让模型调用现成求解器来'作弊式解题'"，§6.6 展开了抗作弊。这里的硬边界：

- `bench` 的 **judge/report** 可以 import `@rubcube/cube-core/metrics`、`/solver` 和 Node-only 的 `/optimal` 来算 `progress_score` / `optimality_ratio`——这是裁判的尺子；结果只进 trace/report，不在回合进行中返回模型
- 赛道 A 没有工具；赛道 B 暴露的注册表严格只有 `apply_moves` / `get_state`，其执行闭包不得直接或间接到达 `solver`、`tutorial` 或依赖 solver 的 `metrics`
- 赛道 C 明确允许代码执行，属于另一条开放赛道，不受上述能力限制，也绝不与 A/B 混分
- `tutorial` 只被 app 引用；`bench` 全目录都不得 import 它

只 grep `bench/src/tools/` 的直接 import 不足以证明“间接”隔离。包出口和构建检查共同执行下面的依赖 DAG：

```text
@rubcube/cube-core                 rules: state / moves / facelet / scramble
@rubcube/cube-core/solver          app solver Worker + bench judge only
@rubcube/cube-core/optimal         bench judge only，Node-only
@rubcube/cube-core/metrics         bench judge/report only，依赖 solver
@rubcube/cube-core/tutorial        app only

bench/tools runtime closure  ───→ @rubcube/cube-core
bench/judge               ──────→ @rubcube/cube-core + /metrics + /solver + /optimal
app/tutorial              ──────→ @rubcube/cube-core + /tutorial
```

`package.json#exports` 必须列出这些子路径，root barrel 不得重导出 `solve`、`loadTables`、`nextStep`、`tutorialRank` 或 solver-backed metrics。仓库内也禁止用相对路径绕开 exports。

在现有 `conventions.test.ts` 同类测试中加入四层防线：

1. 从赛道 B 的实际 tool runtime entry 生成 bundler metafile/模块图，遍历**传递闭包**，断言不含 `/solver`、`/tutorial`、`metrics` 和 Node adapter；动态 import 也必须出现在图中
2. 扫整个 `bench` 的模块图，断言完全没有 `/tutorial`；solver 只允许出现在 judge/report allowlist，不允许出现在 tools、adapter 或模型循环闭包
3. 实例化真实 `ToolSet`，断言工具名恰为 `apply_moves/get_state`，输入/输出 schema 做快照，返回值不得出现 solution、hint、progress、stage 或 algorithm 字段
4. 对默认 `@rubcube/cube-core` 出口做 API 快照，确保以后新增 barrel export 不会把裁判能力意外带回工具闭包

真正的安全边界是模型可调用的 capability 和返回 schema；import 检查是防止工程重构悄悄跨线的第二道门，不替代运行时白名单。

---

## 5. 里程碑

DESIGN.md §8 是已经同步的粗粒度路线图；这里给出细化语义。k≤9 的真最优实现是 §2.8 的双向搜索；若 M3b UI 暴露“下一步”，它只表示求解器解的首步、没有教学解释，教学提示属于独立的 M3.5。

| 阶段 | 内容 | 产出 |
|---|---|---|
| **M2.5** | commit provenance、baseState 历史 reducer、Undo、倒带、fallback 等价 | 练习可用；历史状态机性质测试通过 |
| **M3a** | 坐标、移动表、剪枝表、artifact/cache 契约 + 跨端表大小/耗时实测 | 定下 §2.6 的方案 A 还是 B |
| **M3b** | 两阶段搜索 + Worker client/cache adapter | 游戏内「快速自动复原 / 求解器下一步」；产生候选 `progress_score` |
| **M3c** | 双向最优解（Node only） | k≤9 的 `optimality_ratio` 可算 |
| **M3d** | **距离代理验证 profile**（DESIGN.md §9 待决 1） | 相关性、误差、逆序、局部一致性与 coverage 达标后才启用 `progress_score`；不成立则切换指标实现 |
| **M3.5** | 模块三：策略表、七阶段 policy、公式变体、高亮/fallback、step coordinator、教程 UI | 可跟练、提示、演示的教学模式 |

依赖关系不是简单按小数顺序串行：

- `M3a → M3b → M3d` 是 benchmark 指标关键路径；M3d 没给结论前可以开发 M4 runner，但不能发布使用该 `progress_score` 的正式报告
- M3c 依赖规则内核，不进入浏览器，可与 M3b 后半段并行
- M2.5 依赖 renderer 的 commit provenance；M3.5 依赖 §3.7 的 renderer 高亮扩展和 M2.5 的 batch/command lifecycle、step completion boundary，但**不依赖 Kociemba solver**
- M3.5 是新增的人类产品范围，不阻塞 M4/M5 benchmark v1；若排期冲突可后移，但不能把 M3b 的无解释“下一步”冒充教学提示

**M3a 的实测结果决定 M3b 的资产形态，二者不要并行拍板。** 主文 §2.1 目录、§8 里程碑和算法名称必须持续与这份细化同步；当前两份文档采用同一组 M2.5/M3a–d/M3.5 语义。

**当前 M3b 状态（2026-08-20）：** 两阶段搜索、朝向入口（§2.0）、可暂停内核、四种返回分支与确定性均已完成并实测（见 §2.9）；Worker client 与 cache adapter 尚未落地，因此 M3b 仍是进行中。

当前 M3a 的代码部分与单机 Node 基线已完成；目标浏览器、移动设备、Node CI、持久化/cache-hit 与资产 I/O 的决策级测量尚未完成，所以本里程碑仍是进行中，方案 A/B 仍未选定。

---

## 6. 待决问题

1. **表生成到底多慢？** 已有单机 Node 三次冷进程基线，但仍没有跨目标环境的 P50/P95。M3a 还要在目标浏览器、目标移动设备和 Node CI 冷/热路径分别测量生成、校验、持久化与加载耗时，再决定采用 Worker 生成缓存还是打包带版本校验的二进制资产；不能把本机约 0.86 s 直接外推到用户设备。
2. **阶段 1 要枚举多少条解才够？** 枚举越多解越短但越慢。需要在"解长中位数"和"P99 耗时"之间实测定档。
3. **离线策略给出的直觉步是否像人走的？** 技术路线已经定为离线搜索生成、运行时查表；仍需拿真实用户验证并列解的确定性 tie-break 和旁白是否自然。若不好教，改 policy 的代价函数，不退回主线程 BFS。
4. **顶层归位要不要教 2-look 之外的东西？** 本文的 6 条公式是最小集，代价是步数偏多（中位数 ~70）。要不要给进阶用户提供 OLL/PLL 扩展，是产品问题不是技术问题。
5. **教程文案的国际化。** 本文假设中文。DESIGN.md 全文没提 i18n，如果要做，`caseId → 文案` 这张表是唯一需要翻译的地方——设计上已经把它隔离好了。
