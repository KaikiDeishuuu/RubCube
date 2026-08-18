# RubCube 设计文档

> 一个 Web 魔方游戏 + LLM 空间推理评测平台
> 版本 v0.1 · 2026-08-17

**配套文档**：[DESIGN-SOLVING.md](DESIGN-SOLVING.md) —— 走子历史与回放（M2.5）、Kociemba 求解器与距离代理验证（M3a–d）、分层教学模式（M3.5）的实现级设计。主文定义范围和里程碑，配套文档定义算法与接口；两者冲突时必须先同步主文，不能静默以其中一份为准。

---

## 1. 目标与非目标

### 1.1 双重目标

| 目标 | 说明 | 成功标准 |
|---|---|---|
| **A. 人类可玩** | 流畅、手感好的 3D 魔方，支持速拧计时、统计与分层教学 | 稳定 60fps；拖拽转层 1:1 跟手；WCA 规则计时；教程从任意合法状态收敛，且每个完整 `TutorialStep` 提交后不破坏已完成阶段 |
| **B. 模型评测** | 把魔方当作 LLM 空间推理 / 世界模型 / 规划能力的 benchmark | 可复现、抗污染、有细粒度进度指标而非只有「解出/没解出」 |

这两个目标共享同一个内核：**`cube-core` 是唯一的规则真相源**。玩家看到的状态和模型看到的状态由同一份代码生成，避免"评测环境和游戏不是一回事"这种经典塌房。

### 1.2 非目标（v1 明确不做）

- 多人对战 / 排行榜服务端
- 非 3×3 的完整支持（架构预留，但求解器与评测只覆盖 3×3）
- 移动端原生 App（PWA 即可）
- 让模型调用现成求解器来"作弊式解题"（见 §6.6）

---

## 2. 技术栈

| 层 | 选型 | 理由 |
|---|---|---|
| 语言 | TypeScript（strict） | 内核要在浏览器和 Node 评测器里共用 |
| 渲染 | Three.js（直接用，不套 R3F） | 转层动画需要精确控制 `attach`/`detach` 与帧循环，R3F 的声明式抽象在这里是负担 |
| UI | React + Zustand | UI 状态少，Zustand 足够；避免 Redux 样板 |
| 构建 | Vite + pnpm workspace | Monorepo，内核包被 web 和 bench 共同依赖 |
| 评测器 | Node CLI（headless，不加载 Three.js） | 跑批不需要渲染 |
| 模型 SDK | `@anthropic-ai/sdk`（主）+ OpenAI 兼容适配层 | 见 §7 |
| 结果存储 | JSONL（原始 trace）+ SQLite（聚合查询） | 单机可跑，不引入服务端依赖 |

### 2.1 目录结构

下面是目标结构；标注后续里程碑的文件尚未落地。

```
packages/
  cube-core/          # 零依赖纯 TS。浏览器 + Node 共用
    src/
      state.ts        # Cubie 表示、solved 判定
      moves.ts        # Singmaster 记号解析 / 序列化 / 应用
      facelet.ts      # Cubie <-> 54 字符 facelet 互转
      scramble.ts     # 纯随机状态/随机步采样（种子可控，不依赖 solver）
      solver/
        index.ts      # 独立 /solver package subpath
        constants.ts  # 坐标基数、走法顺序、表规格与 fingerprint
        coordinates.ts # 六种坐标的 rank/unrank
        tables.ts     # 移动表与 nibble 剪枝表生成
        artifact.ts   # RBCT 二进制契约与注入式缓存
        types.ts      # artifact/store/profile 公共类型
        kociemba.ts   # M3b：两阶段搜索（基线 & 上界）
      optimal/
        bidirectional.ts # k<=9 的双向最优搜索；Node/bench 专用入口
      tutorial/
        stages.ts     # 七阶段判据、锁定块与进度阶梯
        algorithms.ts # 具名公式、旋转变体与 case classifier
        policy.ts     # 策略表解码、ranking 与 lookup
        generated-policy.ts # 构建期生成的 packed policy + fingerprint；不手改
        next-step.ts  # 纯领域 TutorialStep；不依赖渲染层 ID
      metrics.ts      # 距离启发式、阶段完成度、进度分
      rng.ts          # mulberry32 种子随机
    scripts/
      benchmark-solver-tables.mjs # M3a：Node 冷生成/编解码/压缩基准
      generate-tutorial-policy.ts # M3.5：Node 构建工具；不进入运行时 package exports
  cube-render/        # Three.js 渲染 + 动画 + 交互
  app/                # React 游戏界面、历史、计时器、统计、教程与 solver Worker
  bench/              # 评测 CLI
    src/
      adapters/       # anthropic.ts / openai-compat.ts
      tasks/          # T1..T6 任务生成器
      runner.ts       # 跑批调度、预算控制、断点续跑
      report/         # 聚合 + HTML 报告
  server/             # 可选：API key 代理 + 结果上报
```

**硬性约束：`cube-core/src` 不得 import 任何渲染或 Node 专属 API。** 这是整个设计的基石。默认入口只导出 state/moves/facelet/rng，以及不依赖求解器的随机状态/随机步采样；`/solver`、`/optimal`、`/metrics`、`/tutorial` 都是独立 package subpath，根入口不得重新导出。WCA-style 的“随机状态 → 求解 → 逆序”由 app 的 solver Worker 编排，不能放进默认入口的 `scramble.ts` 形成 `root → solver` 的间接依赖。浏览器 app 不得静态依赖 Node-only 的 `/optimal`；教程用领域 `CubieRef`/`SlotRef`，由 app 映射到 `cube-render` 的视觉 ID。`cube-core/scripts` 是可使用 Node 的构建工具，但不属于运行时源码，也不进入 exports。

截至 2026-08-17，只有 `/solver` 子路径及其 M3a 表层已经落地；`/optimal`、`/metrics`、`/tutorial` 和 `kociemba.ts` 仍属于后续里程碑。生产 app 的模块闭包必须继续保持不含 `/solver` 与 `/optimal`。

---

## 3. 核心数据模型

### 3.1 状态表示：Cubie 层（权威）

不用 54 格贴纸数组作为权威状态。理由：贴纸表示无法廉价校验合法性，也无法直接喂给求解器。用**块级（cubie）表示**：

```ts
export interface CubeState {
  /** 角块置换：cp[i] = 当前占据位置 i 的角块编号 (0..7) */
  cp: Uint8Array;   // len 8
  /** 角块朝向：0/1/2，顺时针扭转次数 */
  co: Uint8Array;   // len 8
  /** 棱块置换 (0..11) */
  ep: Uint8Array;   // len 12
  /** 棱块朝向：0/1 */
  eo: Uint8Array;   // len 12
}
```

中心块固定（白 U / 绿 F 的标准配色），所以状态空间是标准的 43,252,003,274,489,856,000 个。

**合法性校验**（三个不变量，必须有单元测试）：

1. `cp` 和 `ep` 各自是合法置换
2. `sum(co) % 3 === 0`（角朝向守恒）
3. `sum(eo) % 2 === 0`（棱朝向守恒）
4. `sgn(cp) === sgn(ep)`（置换奇偶性一致）

任何来自外部（模型输出、URL 分享、存档）的状态都必须过这四关。

### 3.2 Move 表示

```ts
export type Face = 'U' | 'D' | 'L' | 'R' | 'F' | 'B';
export type Move = { face: Face; turns: 1 | 2 | 3 };  // 3 === 逆时针(')
```

内部用 `turns: 1|2|3`（顺时针 90° 的次数），避免负数取模的边界 bug。

**评测中只允许 18 个 HTM 面转**（`U U' U2 D D' D2 L L' L2 R R' R2 F F' F2 B B' B2`）。宽层（`Uw`/`u`）、中层（`M E S`）、整体旋转（`x y z`）在游戏里支持，但**在评测输入输出中禁用**——它们的记号约定在不同社区有分歧，会污染指标。

解析器必须严格：非法 token 抛错并被计入 `invalid_move_rate` 指标，绝不静默忽略。

### 3.3 Facelet 表示（对外接口）

给模型和分享链接用的是 54 字符串，采用 **Kociemba 标准编号**：

```
             ┌─────────┐
             │U1 U2 U3 │
             │U4 U5 U6 │
             │U7 U8 U9 │
   ┌─────────┼─────────┼─────────┬─────────┐
   │L1 L2 L3 │F1 F2 F3 │R1 R2 R3 │B1 B2 B3 │
   │L4 L5 L6 │F4 F5 F6 │R4 R5 R6 │B4 B5 B6 │
   │L7 L8 L9 │F7 F8 F9 │R7 R8 R9 │B7 B8 B9 │
   └─────────┼─────────┼─────────┴─────────┘
             │D1 D2 D3 │
             │D4 D5 D6 │
             │D7 D8 D9 │
             └─────────┘
```

字符串拼接顺序：**U1..U9, R1..R9, F1..F9, D1..D9, L1..L9, B1..B9**

复原态：
```
UUUUUUUUURRRRRRRRRFFFFFFFFFDDDDDDDDDLLLLLLLLLBBBBBBBBB
```

**用面字母（U/R/F/D/L/B）而非颜色字母**——面字母天然无歧义，不依赖配色方案。UI 层再映射到颜色（U=白 R=红 F=绿 D=黄 L=橙 B=蓝，WCA 标准）。

这个约定必须在系统提示词里用上面这张展开图**逐字说明**。魔方 benchmark 最常见的失败不是模型不会推理，是它对索引约定的理解和你不一样。

### 3.4 NxN 扩展预留

3×3 用 cubie 表示（为了求解器）；4×4 及以上没有实用的最优求解器，用通用的**贴纸数组 + 层旋转索引映射**实现。两者暴露同一个接口：

```ts
interface Puzzle {
  apply(move: Move): void;
  isSolved(): boolean;
  toFacelets(): string;
  clone(): Puzzle;
}
```

渲染层只依赖 `Puzzle` 和「每个小方块的整数坐标 + 朝向」，不关心内部表示。

---

## 4. 渲染与动画

这是"手感"的全部所在。核心原则：**逻辑状态是整数，视觉状态从整数派生，永不反向依赖。**

### 4.1 场景构成

- 26 个小方块（去掉不可见的核心），每个是一个圆角立方体（`RoundedBoxGeometry`，圆角半径约边长的 6%）
- 26 个 cubie 共享一份 geometry，但各自持有一个 `MeshStandardMaterial`。贴纸色、塑料色、圆角遮罩和粗糙度由同一套自定义 shader 按物体空间法线/位置逐片元决定，不使用 6 个面材质槽
- 26 个 material 共享同一个 shader program cache key，因此仍是 26 次 draw call；独立 uniform 状态则为按物理块高亮保留了入口
- **不开 shadow map**。用一个预生成的径向渐变贴图做地面接触阴影（一个 plane + `MeshBasicMaterial` + `transparent`），成本近零，观感更好
- 用 `RoomEnvironment` 生成一张小的 PMREM 环境贴图做塑料高光，这是"看起来贵"的最大单点收益

### 4.2 转层动画：Pivot Group 方案

下面只示意**单层**的 attach / rotate / detach 原理；生产实现不是一个全局 `private pivot`，而是 §4.4 的 `ActiveGroup` 为每个并发层持有独立 pivot，并在组提交时统一回收。

```ts
class TurnAnimator {
  private pivot = new THREE.Group();

  begin(layer: Cubie[], axis: THREE.Vector3) {
    this.pivot.rotation.set(0, 0, 0);
    this.scene.add(this.pivot);
    // attach 保留世界变换，这是关键 —— 不要用 add()
    for (const c of layer) this.pivot.attach(c.mesh);
  }

  update(progress: number, axis: THREE.Vector3, totalAngle: number) {
    this.pivot.setRotationFromAxisAngle(axis, ease(progress) * totalAngle);
  }

  end(state: CubeState) {
    for (const mesh of [...this.pivot.children]) this.scene.attach(mesh);
    this.scene.remove(this.pivot);
    // 关键：不从当前浮点变换收尾，而是从权威整数状态重建
    this.syncFromState(state);
  }
}
```

**`end()` 里必须从整数状态重建视觉变换，而不是把浮点变换四舍五入。** 前者浮点误差恒为零；后者跑几千步之后方块会肉眼可见地歪掉。这是魔方渲染最经典的坑。

### 4.3 缓动与时长

主缓动是三次 Hermite —— 能指定两端速度的最简曲线：

```ts
// e(0) = 0, e(1) = 1, e'(0) = entry, e'(1) = exit
function ease(t: number, entry: number, exit: number): number {
  const t2 = t * t;
  const t3 = t2 * t;
  return entry * (t3 - 2 * t2 + t) + (3 * t2 - 2 * t3) + exit * (t3 - t2);
}
```

这里的 `entry` / `exit` 是对归一化时间 `t ∈ [0, 1]` 求导得到的**无量纲进度速度**，不是 rad/s。对总扫角 `Δθ` 和时长 `duration` 的一层，真实角速度是：

```
ω(t) = (Δθ / duration) × e'(t)
```

它的两个特例正好就是需要的两条曲线：

| entry, exit | 展开后 | 用在哪 |
|---|---|---|
| `(2, 0)` | `2t - t²`，即 easeOutQuad | 孤立单步：起手快、收尾稳，最贴近真实塑料件手感 |
| `(1, 1)` | `t`，即匀速 | 序列中间：接缝处不减速 |
| `(v, 0)` | —— | 拖拽松手：`v` 由手指末速度换算，手指停住了就是 0 |

**实现主动把两端速度限制在 `[0, 2]`。** `e'(t) = (3·entry + 3·exit − 6)t² + (6 − 4·entry − 2·exit)t + entry`；`[0, 2]` 是保证曲线单调且不会有过强冲量的保守工程范围，不是数学上的必要边界。例如 `(3, 0)` 仍是单调的 `1 - (1 - t)³`，但不用它，因为起手冲量过大。

选取规则以**动画组**为单位：前面没有已衔接的组时 `entry = 2`，否则 `entry = 1`；创建该组时队列仍有后续步骤则 `exit = 1`，否则 `exit = 0`。因此孤立组是 `(2, 0)`，已知序列的首组是 `(2, 1)`，中间组是 `(1, 1)`，尾组是 `(1, 0)`。`R U R' U'` 的中间两组归一化进度是精确线性的，不会在每个接缝人为归零。

**曲线在组创建后冻结。** 动画已开始后新调用的 `enqueue` 只会进入后续队列，不会中途改写当前组的 `exit`，否则会使已播放的角度跳变。所以分两次调用 `enqueue('R')` 和 `enqueue('L')` 不会后补成并发；要利用序列缓动或对面层并发，调用者应一次批量入队。

队列转层的时长：

```
duration = base × clamp(1 - 0.12 × (queueLen - 1), 0.45, 1) × √(|angle| / 90°)
```

公式内部统一使用秒，`base = 0.120 s`（下表为便于阅读换算成 ms）。`queueLen` 是**创建动画组前队列中的 move 总数**，包括马上要取出的 1–2 步。并发组的每层都使用同一个 `queueLen` 计算候选时长，组时长取候选值中的最大值；不把第二层虚拟成 `queueLen - 1`。例如仅有 `R L` 时，两层共用 105.6ms，不是 120ms。

| 场景 | 90° 单层候选时长 |
|---|---|
| 手动单步 90° | 120ms |
| 队列长度 2–5 | 106ms → 62ms |
| 队列长度 > 5（如打乱、AI 回放） | 54ms |

180° 在表中对应的值上再乘 `√2`，所以孤立 `R2` 约为 170ms。**第三个因子不能省。** 180° 扫过的角度是 90° 的两倍，给相同时长就是两倍角速度。开方折中把差距降到 `√2` 倍；它**不是**等角速度，而线性缩放又会让孤立 `R2` 变成 240ms，太拖。

拖拽吸附不用上面的开方规则，而是按剩余扫角线性缩放：

```
settleDuration = 0.120s × |θtarget - θrelease| / (π/2)
entry = clamp(ωfinger × settleDuration / (θtarget - θrelease), 0, 2)
exit = 0
```

`ωfinger` 是带符号的手指末角速度（rad/s），`settleDuration` 必须以秒代入；用有符号的剩余扫角（rad）做除法，手指继续朝目标运动才得到正的 `entry`，背离目标则夹到 0。剩余扫角为 0、`settleDuration = 0` 或末速度样本已过期时也取 0。

已知且接受的节奏起伏：首组 `(2, 1)` 的归一化速度在 `t = 2/3` 处取最小值 `2/3`，尾组 `(1, 0)` 在 `t = 1/3` 处取最大值 `4/3`。不是所有 `entry ≠ exit` 的三次曲线都有内部极值；如 `(2, 0)` 的速度就是单调线性下降。五次 Hermite 可以额外强制两端加速度为零，但在保持端点速度与总位移不变时，不能把这类速度起伏完全消除。

本方案的目标是**避免每步归零，而不是让三维物理速度 C¹ 连续**。即使接缝两边都是归一化速度 1，队列深度每减一步仍会产生约 12%–19% 的实际角速度台阶；并发组一次消耗两步时可达约 32%。90°/180° 混合、转向反转（如 `R R'`）或旋转轴变化（如 `R U`）也不会物理连续。这些是刻意接受的“不停顿的节奏”折中，不应在 API 或测试中声称为速度连续。

有意未实现的两项：

- **"咔哒感"末段过冲**（overshoot 1.04，仅单步手动启用）。连续播放时会晕，为单一场景加一条特例分支不划算。
- **回放倍速 `base × 1/speed`**。等回放 UI 落地时再接。

### 4.4 并发转层

**如果两步涉及的小方块集合不相交，就可以并行播放。** `QueuedMove` / `CommitProvenance` 的完整定义见 DESIGN-SOLVING.md §1.2。在当前 3×3 且 `Move` 只包含六个外层面转的前提下，只有对面层满足这个条件 —— `U` 和 `D`、`R` 和 `L`、`F` 和 `B`：

```ts
canOverlap(a: QueuedMove, b: QueuedMove): boolean {
  return a.provenance.commandId === b.provenance.commandId
    && oppositeFace(a.move.face) === b.move.face;
}
```

由此可证**并发上限是 2**：任意第三个面必然与前两个之一共享 cubie。

这个判定只在**新组从已知队列取步骤时**执行：先取队首，只有紧跟的第二步既属于同一个 `commandId`、又是对面层才一起取出。不同命令永不共享 `ActiveGroup`，否则按命令取消就没有原子边界。不跳过中间 move 去找后面可并发的层，也不把动画开始后才入队的 move 追加到当前组。将来支持宽层、中层或整体旋转后，不能沿用 `oppositeFace`；要改为比较实际 cubie 集合。

关键实现约束：**同时播放的层共用一个时钟，一起开始、一起结束。**

```ts
interface ActiveGroup {
  layers: ActiveLayer[];  // 1 或 2 个，各自持有一个 pivot
  elapsed: number;        // 共用
  duration: number;       // 同一 group queueLen 下，取各层候选时长最大值
  entryVelocity: number; // 共用的归一化 Hermite 端点速度
  exitVelocity: number;
}
```

每层都用共享的 `progress = elapsed / duration` 和同一条 Hermite 曲线插值自己的 `startAngle → targetAngle`。因此 90° 和 180° 对面层可以同时到达；代价是它们的实际角速度不同，这是上节已接受的折中。

这不是为了整齐，是为了正确性。如果两层各走各的时钟，先结束的那个要 `applyMove` 并调 `syncVisuals` 从整数状态重建全部 26 个 cubie 的变换 —— 而另一层的 9 个 cubie 此刻还挂在 pivot 底下，`syncVisuals` 写进去的是它们的**局部**变换，pivot 的旋转会被重复叠加一次。共用时钟让这个时刻根本不存在。

顺带也解决了提交顺序：两层同时结束，就在同一个 tick 里按队列顺序依次 apply。**逻辑状态仍然严格按顺序 apply，只有视觉是重叠的。**（对面层的 move 本来就可交换，最终状态与顺序无关，但 `CommitBatch.changes` 的 move 序列必须和用户请求的一致。）

并发组的完成是一个不可重入打断的提交事务，顺序固定为：

1. 先把组内所有 cubie 从各自 pivot `attach` 回 scene，保留当前世界变换。
2. 按原队列顺序逐步 `applyMove`，并在每步后克隆一份 `CubeStateChange.state` 快照。
3. 全部 apply 完成后，只调一次 `syncVisuals(finalState)`，从最终整数状态重建 26 个 cubie。
4. 把第 2 步的有序快照封装成一个 `CommitBatch`，只派发一次 batch 事件；batch reducer 完成后才允许下一个动画组启动。

```ts
interface CommitBatch {
  readonly batchId: number;
  /** 按逻辑提交顺序；每项 state 是该 move/replace 之后的不可变快照。 */
  readonly changes: readonly CubeStateChange[];
  readonly finalState: CubeState;
}

interface CommandEnd {
  readonly commandId: string;
  readonly status: 'completed' | 'cancelled' | 'failed';
  readonly committedMoves: number;
  readonly reason?: string;
}

type DispatchEvent = CommitBatch | CommandEnd;

interface MoveTransport {
  readonly isBusy: boolean;
  enqueue(moves: readonly Move[], provenance: CommitProvenance): boolean;
  replaceState(state: CubeState): void;
  cancelPlayback(reason: string): void;
}
```

`change.state` 报告的是**它自己那一步之后**的历史快照；`batch.finalState` 才是该组结束后的 live state。app 在一次 store transaction 中按 `changes` fold 历史/教程状态，最后只公开 `finalState`，不能在处理中重读 `animator.state` 代替某个中间快照。教程只在 batch 尾做完成或错步重算判定，不能在第一项上基于已过时的中间态生成下一 step。

`CubeState` 内含可变 `Uint8Array`，TypeScript 的 `readonly` 不是运行时隔离。transport 的权威 state 永不外借；batch 内所有 state 都是深克隆，dispatcher 给每个非权威 observer 独立的防御性副本（或等价的只读 packed 表示），一个恶意/有 bug 的 listener 不能污染后续 listener。`enqueue` 在 accepted 时也复制 moves 与 provenance，调用方之后修改原数组/对象不得改变队列。

**提交分发期间的变更必须延迟。** listener 里的 `enqueue`、`replaceState` 和 `cancelPlayback` 不得在当前 batch/command-end 事件中途生效，而要按调用顺序进入一个全局 deferred-command FIFO。唯一事件顺序是：renderer 提交并同步 group → 非重入派发 `CommitBatch` → 权威 reducer 若失败则终止当前命令并派发 `CommandEnd(failed)`，否则若该 batch 正好耗尽命令则派发 `CommandEnd(completed)` → 两类事件及其观察者全部返回 → drain 全局 FIFO → 最后统一尝试启动新组。最终 batch 回调中请求 replace/cancel 时，旧命令已经 completed；非终末 batch 的 deferred cancel 则先令旧命令 cancelled，再处理 replace/new command。

dispatcher 使用单一非重入 event/deferred drain loop；drain 时产生的 command-end、replace batch 或它们回调里新增的操作都追加到同一 FIFO 尾部，不能递归插到旧事件中间。这样 `enqueue → replaceState` 会由后者清队列，`replaceState → enqueue` 则会从新状态播放，语义和调用顺序一致。

错误分两层：非权威观察者抛错时记录并继续派发，不能让异常逃出帧循环；app 对 `CommitBatch` / `CommandEnd` 的权威 handler 则必须用纯 draft 原子计算 history + cube + tutorial，验证通过后一次提交。统一错误口是 `onDispatchError(event, error, latestCommittedState, source)`，其中 `source` 明确区分 `authoritative` / `observer` / `transport`，不能只覆盖 batch，也不能把 observer 错误误判成 fatal。

- batch handler 失败时，当前 batch 已经在 transport 内完整提交，不能假装回滚；app 以 `latestCommittedState = batch.finalState` 建诊断 checkpoint、清空 tutorial coordinator 并进入 fatal invariant 状态
- command-end handler 失败时，该 end 在调用 handler **之前**就标记为已派发，不能再补第二个 end；cube/history 已由先前 batch 成功发布，保持不动，只清 coordinator 并进入 fatal
- 进入 fatal 前，dispatcher 遍历 active queue、transport queue 和 deferred FIFO；所有已接受但尚未 end 的 enqueue/drag command 各派发一次 `failed`，非命令型 replace/cancel 操作直接丢弃。fatal 清理期间拒绝新命令，end handler 再抛只记诊断，不递归产生 end

失败时不执行普通 deferred commands。所谓“停止命令”只阻止后续 group，永远不能撤回当前已提交 batch；显式 Reset/重载是唯一恢复入口。

WebGL animator 和 2D fallback 都实现上面的 `MoveTransport`，并把 `CommitBatch` / `CommandEnd` 送进同一个 transport-independent `CommitDispatcher`；command registry、`commandRevision`、deferred FIFO、异常隔离和 batch-final 语义只实现一份。fallback 不能绕过 dispatcher 直接调用历史 reducer。

dispatcher 在接受任意非空 enqueue 或 drag begin 时，先登记 `commandId`、同步递增 `commandRevision`，再交给 transport；renderer 内部生成的 drag ID 也必须经过这条 acceptance hook，不能等到首个 commit 才通知 app。`commandId` 在 dispatcher 生命周期内必须唯一，复用已 active/ended 的 ID 要在 acceptance 前拒绝。`enqueue([])` 是严格 no-op：返回 `false`，不登记 command、不增 revision、也不产生 end。replace/cancel 不是 command，但被接受时仍递增 revision。

`cancelPlayback(reason)` 的语义固定如下：若 active group 尚未进入提交事务，先从最后的整数状态重建视觉，使整个 group **零提交**，再清空它和所有排队命令；若在 batch 回调中调用，则延迟到当前 batch 收尾，当前 batch 保留、只取消余下后缀。已提交前缀永不回滚。每个 `commandId` 只用于一次连续 enqueue，并恰好收到一个 `onCommandEnd`；正常耗尽为 `completed`，显式取消/replace 为 `cancelled`，context loss/dispose/内部故障为 `failed`。取消、replace 和所有 enqueue 一样，在公共调用被接受时就递增 app 的 `commandRevision`。

上述屏障不是“并发专用”：单步、拖拽吸附、replace、reduced-motion 与 fallback 都产生大小为 1 的 batch，并遵守完全相同的分发屏障。replace **不是 move command**，没有 provenance，也没有自己的 `CommandEnd`；`replaceState` 先让所有尚未结束的旧 command 发 cancelled，再派发一个 `move: null` 的 replace batch。

一次 drag command 也必须恰好结束一次：成功吸附并提交一转是 `completed/committedMoves: 1`；小角度回弹、未锁方向松手、lost pointer capture 或显式取消是 `cancelled/0`；context loss 或内部故障是 `failed/0`。不能让零提交拖拽把跟练模式的“一个未提交 move”门锁死。

fallback 不得在一次同步调用里耗尽整个公式/倒带。它每次最多提交一个大小为 1 的 batch，随后用 macrotask 或下一帧让出事件循环，再检查 cancel/replace 和队列；因此几百步回放也可在 batch 边界取消。WebGL 与 fallback 可以有不同墙钟节奏；同一组没有中断的命令必须得到相同最终状态、历史和 end 状态，`isBusy` 也采用相同定义。

取消只保证保留**当前 backend 已完整提交的原子 batch 前缀**，不能保证对观察时机敏感的逐 move 前缀跨 backend 完全相同：WebGL 的对面层组可一次原子提交 2 步，fallback 则一次只提交 1 步。因此在“首个 batch observer 中取消 `R L U`”这个刻意依赖 batch 边界的场景里，WebGL 报告 `cancelled/2`，fallback 报告 `cancelled/1`；二者都不得拆开或撤回已经发布的 batch，`committedMoves` 必须如实报告。若产品将来需要“恰好第 N 个逻辑 move 后取消”的跨 backend 确定性，必须新增按 move index 的调度协议，不能用墙钟或 observer 次数冒充。

`reducedMotion` 下不并发：没有动画可以重叠，串行也保住了"每帧一步"的契约。

### 4.5 帧循环

```ts
renderer.setAnimationLoop((time) => {
  const dt = Math.min((time - last) / 1000, 0.05); // 钳制，防止切标签页回来跳帧
  last = time;
  animator.tick(dt);
  controls.update();
  if (animator.isActive || controls.isMoving || needsRedraw) {
    renderer.render(scene, camera);
    needsRedraw = false;
  }
});
```

- 动画进度用**累计时间**驱动，不用帧计数
- 空闲时跳过 render（按需渲染），笔记本电池友好
- `renderer.setPixelRatio(Math.min(devicePixelRatio, 2))` —— 3x 屏上全分辨率渲染是纯粹的浪费
- `powerPreference: 'high-performance'`，`antialias: true`
- 每帧零分配：复用 `Vector3`/`Quaternion` 临时对象

### 4.6 交互

**拖拽转层（核心手感）**

1. `pointerdown` → raycast 命中贴纸，得到 `(cubie, faceNormal)`，记录命中点
2. `pointermove` → 位移向量投影到该面的两个切向量上，取模长较大者
3. 位移超过阈值（~8px）后锁定方向：`axis = faceNormal × tangent`，层 = 该 cubie 在 axis 上的坐标
4. **锁定后 1:1 跟手旋转**（拖拽距离映射到旋转角度），松手时吸附到最近的 90° 倍数
5. 如果松手时角度 < 30°，回弹取消；否则补完这一步并 commit 到逻辑状态

1:1 跟手 + 松手吸附是"高级感"的来源。直接触发离散 90° 转动的实现会明显廉价。

**相机控制**：空白处拖拽 = arcball 轨迹球旋转；滚轮/双指缩放（限制在合理 FOV 范围）；不允许平移（会迷路）。

**键盘**：采用 csTimer 系风格的速拧键位（`j`=U, `f`=U', `i`=R, `d`=L' 等），可自定义映射。

### 4.7 无障碍与降级

- `prefers-reduced-motion` → 动画时长降到 1 帧（瞬移），保留状态正确性
- WebGL 不可用 → 降级到 2D 展开图交互（用 facelet 表示直接渲染 SVG），功能完整只是不好看
- 全部操作有键盘等价路径

---

## 5. 游戏逻辑

### 5.1 打乱

**随机状态打乱**（WCA-style，M3b 后的主路径）：用 seed 均匀采样一个合法状态 → 用确定性 Kociemba profile 求出并验证“该状态 → 复原态”的解 → `invertMoves` 得到“复原态 → 该状态”的展示序列。均匀的是目标状态，不是序列；序列长度取决于 solver profile，通常约 18–22 步但不作为正确性契约。正式计时/WCA-labeled 路径不设墙钟 deadline，拒绝并重新采样距复原少于 2 HTM 的极端状态；若固定节点预算在首解前耗尽，就报告生成失败或用更高的已登记 profile 重试，不能静默改成另一种分布。休闲 UI 才可以明确标注后降级到下面的 random-move 方案，且绝不显示未验证或被截断的序列。

**随机步数打乱**（回退方案，也用于低难度评测任务）：随机 k 步，约束：
- 不出现连续同面（`R R'`）
- 不出现同轴三连（`R L R`）

评测里必须用**种子化 PRNG**（mulberry32），种子记录进结果，保证可复现。

### 5.2 计时器

WCA 惯例：

```
[空格按下] → 计时器变红（未蓄力）
   ↓ 持续 550ms
[计时器变绿] → 可以开始
   ↓ 松开空格
[开始计时]
   ↓ 任意键
[停止]
```

- 可选 15 秒观察时间：超时 +2，超 17 秒 DNF
- **计时真相源是 `performance.now()`**，不是 rAF 时间戳。显示更新走 rAF，但两者解耦
- 结果落地：`{ time, scramble, solution?, penalty, timestamp }`

### 5.3 统计

- 单次、best、ao5、ao12、ao100（去掉最好最差取平均，WCA 定义）
- 会话（session）管理，导出 CSV（兼容 csTimer 格式）
- 本地 IndexedDB 存储

---

## 6. 模型评测设计

这是项目的差异化核心。设计目标：**测出真实的空间推理能力，而不是测出"谁的训练集里魔方教程更多"。**

### 6.1 三个赛道（必须分开报告）

| 赛道 | 模型能用什么 | 测的是什么 |
|---|---|---|
| **A. 纯推理** | 只有文字/图像输入，单轮输出 | 内部世界模型 + 开环规划 |
| **B. 工具闭环** | `apply_moves` / `get_state` 工具，多轮 | 闭环纠错、agentic 持久性 |
| **C. 开放** | 允许代码执行 | 工程能力（能不能自己写个求解器） |

赛道 C 的分数**不能**和 A/B 混在一起看——它测的是完全不同的东西。一个在 C 上满分的模型可能在 A 上一塌糊涂，这本身就是有价值的结论。

### 6.2 任务套件

| ID | 任务 | 输入 | 输出 | 主要能力 |
|---|---|---|---|---|
| **T1** | 状态预测 | 初始 facelet + k 步序列（k=1,2,3,5,8,12,20） | 最终 facelet | 符号模拟 / 世界模型 |
| **T2** | 序列反推 | 初始 + 最终 facelet（差 k 步，k=1..4） | 移动序列 | 逆向推理 |
| **T3** | 少步复原 | k 步打乱的 facelet（k=1..9） | 复原序列 | 规划 + 搜索 |
| **T4** | 完整复原 | WCA 随机状态打乱 | 复原序列 | 长程规划 |
| **T5** | 图案构造 | 目标图案描述（棋盘格 / 十字 / superflip） | 达成序列 | 目标导向构造 |
| **T6** | 视觉识别 | 两张等轴测渲染图（前上右 + 后下左） | facelet 字符串 | 视觉空间感知 |

**T1 是最干净的信号。** 它完全不需要搜索，纯粹测"模型脑子里有没有一个能跟着转的魔方"。k 从 1 到 20 扫描，画出准确率随 k 的衰减曲线——这条曲线比任何单一分数都更有信息量。

表里的 `k` 是**生成序列长度**，不保证状态真实最短距离恰好为 k。T2/T3 除了记录 generator k，还要用 `/optimal` 记录 `d*` 并按二者分别分桶，防止抵消/等价路径污染难度曲线；判分一律把模型 moves 回放到输入状态检查目标是否达到，不和参考字符串做 exact match。T2、T3、T5 都可能有多条同样正确的序列。

**T6 把感知从推理里剥离出来。** 如果一个 VLM 在 T6 上都读不对状态，那它在 T4 上的失败就不能归因于推理能力。渲染图由 `cube-render` 离线生成，分辨率 1024×1024（Opus 5 / Sonnet 5 支持长边 2576px 高分辨率，但 1024 已足够且更省 token）。

### 6.3 观测格式：三选一，且要做对照实验

同一个任务用三种表示各跑一遍：

1. **facelet 字符串**（54 字符，紧凑）
2. **逐面 JSON**（`{"U": [["U","U","R"],...], ...}`，结构化）
3. **ASCII 展开图**（视觉化，token 最多）

**表示敏感性本身就是一个要报告的指标。** 如果模型在 ASCII 展开图上比 facelet 字符串强 30%，说明它的空间推理严重依赖视觉排版，这是个值得写进结论的发现。

### 6.4 交互协议

**赛道 A（单轮 + 结构化输出）**

```ts
const MoveAnswer = z.object({
  moves: z.string().describe("空格分隔的 HTM 序列，如 'R U R\\' U\\''"),
});

const StateAnswer = z.object({
  state: z.string().length(54).describe("U/R/F/D/L/B 顺序的 facelet 字符串"),
});
```

T2–T5 使用 `MoveAnswer`，T1/T6 使用 `StateAnswer`；task manifest 固定 schema ID。用 `output_config.format` 保证 JSON 外壳可解析，但领域校验仍要检查 move 记号、54 字符字母表/中心和 cubie 合法性，不能把“结构可解析”误当成“答案合法”。

**赛道 B（工具闭环）**

两个工具，且**只有这两个**：

```ts
apply_moves(expected_state: string, moves: string) -> {
  state: string;          // 新的 facelet
  solved: boolean;
  moves_applied: number;  // 累计步数
  budget_remaining: { tool_calls: number; moves: number };
}

get_state() -> { state: string; solved: boolean }
```

预算上限：`max_tool_calls = 30`，`max_total_moves = 300`。这是两个独立的 capability counter，不能拿 SDK 的 `max_iterations` 冒充。每个 tool block 在解析/执行前先原子消耗一次 call（非法参数也占 call）；`apply_moves` 再预检整段 move，若会越过 300 就整段拒绝、零 move 提交。一个 assistant message 若含多个 tool block，严格按 content block 顺序串行执行；会修改同一 cube 的调用绝不能 `Promise.all`。超限即判定失败，并记录超限时最后一个已提交状态的进度分。

**关键设计：要求模型在调用 `apply_moves` 前先声明它预期的结果状态。** 这样可以直接测量「模型自认为的状态」vs「真实状态」的偏差率——这是幻觉率的直接观测，比任何间接指标都准。

### 6.5 指标体系

**别只报 solve rate。** 二值指标在这个任务上分辨率太低——弱模型全 0，强模型全 1，中间什么都看不出来。

| 指标 | 定义 | 说明 |
|---|---|---|
| `solve_rate@budget` | 预算内复原比例 | 主指标，但不够 |
| **`progress_score`** | `1 - proxyLen(s_final) / proxyLen(s_0)`，clip 到 [0,1] | **核心细粒度指标**：用固定 profile 的 Kociemba 解长代理衡量“离复原还有多远” |
| `best_progress` | 轨迹中非 null `progress_score` 的最大值；没有有效点则为 null | 区分“接近过又走丢了”和“一直没进展”；同时报告 trajectory coverage |
| `htm_count` | 复原用的实际步数 | 效率 |
| `optimality_ratio` | `htm_count / optimal_len`（仅 k≤9） | 真最优效率，值 ≥ 1，越低越好 |
| `kociemba_ratio` | `htm_count / kociemba_baseline_len`（k>9） | 相对非最优基线的效率；可能 < 1，不能称为最优率 |
| `invalid_move_rate` | 非法 token / 总 token | 记号掌握度 |
| `state_hallucination_rate` | 赛道 B：预期状态 ≠ 实际状态的比例 | 世界模型保真度 |
| `sticker_accuracy` | T1：48 个可动贴纸逐格正确率 | 六个固定中心另报 sanity check，不能拿必然不动的 6 格抬高主分 |
| `cubie_accuracy` | T1：20 个块（位置+朝向都对）正确率 | 比贴纸更符合问题结构 |
| `tokens_in / out / thinking` | 从 `usage` 直接读 | 成本与效率 |
| `cost_usd` | 按当前定价折算 | |
| `wall_time_s` | 端到端延迟 | |
| `repeatability` | 同一任务重复 n≥3 次后的成功率、标准差与置信区间 | 见 §7.4；不要把重复性统计误叫成标准 `pass@k` |

**`progress_score` 的实现要点**：用 Kociemba 两阶段求解器的解长度作为距离代理。`proxyLen(s)` 在 `solved` 时取 `moves.length`，在 `budget-exhausted` 且 `best !== null` 时取 `best.length`；首解前耗尽、`no-solution-within-hard-max`、取消或错误时为 `null`。初始或最终任一侧为 `null` 时，该样本的 `progress_score` 也为 `null`，trace 必须记录两侧 solver status/节点数，聚合报告必须同时给出 coverage，不能静默丢样本、补 0 或临时混入另一尺度的 PDB 值。`best_progress` 只在非 null 轨迹点中取最大，并同时报告 `valid_points / eligible_points`；没有有效点时为 null。`kociemba_ratio` 的 baseline 复用 `proxyLen(s_0)`，缺失或为 0 时 ratio 为 null；`optimality_ratio` 的真最优分母缺失或为 0 时同样为 null。两个 ratio 都单独报告 coverage。正式报告的最低 coverage 写进 M3d manifest。这个代理不是真最优，能否足够稳定必须由 M3d 的实验决定，不能在实现前当作既定事实。剪枝表约 1.92 MiB，加移动表常驻约 3.62 MiB。k≤9 的短打乱用双向搜索求真最优作校准。

游戏内自动复原可以使用墙钟 deadline；**benchmark 判分不得使用墙钟 anytime 结果**，否则同一状态会因 CPU、负载和 JIT 状态得到不同距离。评测档必须固定 `hardMax`、`targetLength`、`maxNodes`、canonical move order、节点计数规则版本、表版本和 solver fingerprint；同一 solver profile 对同一状态必须返回逐步一致的解长。`progress_score` 只在初始代理距离大于 0 的任务上定义。

### 6.6 抗作弊与抗污染

**抗作弊**

- 赛道 A/B 的工具集是白名单，**不包含任何求解器、不包含代码执行**
- 输出解析后重新在 `cube-core` 里回放验证——模型说"解出了"不算数，引擎说了算
- 检测输出中的求解器特征（Kociemba 坐标、G1 子群术语等），标记但不惩罚（这本身是有趣的行为数据）

**抗污染**

- 打乱**运行时用种子生成**，不用任何公开的 WCA 比赛打乱
- 保留一个**从不公开的 held-out 种子集**用于最终报告；公开一个 dev 集供调试
- 定期轮换 held-out 集
- superflip 这类著名状态只放在 dev 集里（它百分之百在训练数据里）

### 6.7 可复现性记录

每条结果记录必须包含：

```jsonc
{
  "run_id": "...",
  "harness_git_sha": "...",
  "sdk_version": "@anthropic-ai/sdk@x.y.z",
  "model": "claude-opus-5",
  "effort": "high",
  "thinking": { "type": "adaptive", "display": "omitted" },
  "max_tokens": 32000,
  "prompt_hash": "sha256:...",       // 系统提示词 + 任务模板
  "input_hash": "sha256:...",        // 本次规范化文字 + 图像 bytes
  "task_manifest_hash": "sha256:...",
  "pricing_manifest_hash": "sha256:...",
  "representation": "facelet",
  "renderer_fingerprint": null,       // T6 必填：camera/light/asset/render 版本
  "scramble_seed": 1234567,
  "scramble": "R U2 F' ...",
  "distance_solver": {
    "algorithm": "kociemba-v1",
    "solver_fingerprint": "sha256:...",
    "table_fingerprint": "sha256:...",
    "table_artifact_checksum": "crc32:...",
    "table_artifact_sha256": "sha256:...",
    "profile": {
      "hard_max": 30,
      "target_length": 21,
      "max_nodes": 500000,
      "move_order": "htm-v1",
      "node_counter": "dfs-expanded-v1"
    },
    "initial": { "status": "solved", "proxy_len": 7, "nodes": 18422 },
    "final": { "status": "solved", "proxy_len": 0, "nodes": 0 }
  },
  "task_id": "T3-k7-0042",
  "timestamp": "2026-08-17T...",
  "usage": { "input_tokens": 1812, "output_tokens": 6033, "cache_read_input_tokens": 1500 },
  "transcript": [ /* 完整消息序列 */ ],
  "verdict": { "solved": true, "htm": 23, "progress": 1.0, "invalid_moves": 0 }
}
```

**没有 `prompt_hash`、`input_hash` 或 `task_manifest_hash` 的评测结果不可信**——提示词改一个字、图像换一次渲染，分数就不可比了。凡是计算 progress/ratio 的任务还必须有完整 `distance_solver` profile；不使用距离指标的 T1/T6 明确存 `distance_solver: null`，不能省字段制造歧义。T6 还必须保存原始图片 hash 与 renderer fingerprint，不能只记 seed。

---

## 7. 模型接入实现

### 7.1 适配器接口

```ts
export interface ModelAdapter {
  readonly id: string;
  /** 单轮：赛道 A */
  complete(req: CompletionRequest): Promise<CompletionResult>;
  /** 多轮工具循环：赛道 B */
  runAgent(req: AgentRequest, tools: ToolSet): Promise<AgentResult>;
}
```

主实现是 Anthropic，另有一个 OpenAI 兼容层用于横向对比。**适配器只负责协议转换，不负责判分**——判分全部在 `cube-core` 里做，保证跨模型口径一致。

### 7.2 当前模型与定价

下表是 **2026-08-17 的配置快照**，只能作为默认 manifest；模型可用性、价格、上下文和 beta 名称在每次正式跑批前从供应商文档复核并锁进版本化 pricing/model manifest，历史结果绝不按新价格回算。

| 模型 | Model ID | 上下文 | 输入 $/1M | 输出 $/1M | 用途 |
|---|---|---|---|---|---|
| Claude Opus 5 | `claude-opus-5` | 1M | $5.00 | $25.00 | **默认主力**，最强 agentic/推理 |
| Claude Sonnet 5 | `claude-sonnet-5` | 1M | $3.00（8/31 前 $2.00 优惠） | $15.00（优惠 $10.00） | 性价比对照组 |
| Claude Haiku 4.5 | `claude-haiku-4-5` | 200K | $1.00 | $5.00 | 低端基线 |
| Claude Fable 5 | `claude-fable-5` | 1M | $10.00 | $50.00 | 天花板探测（可选） |

模型 ID **不加日期后缀**——`claude-opus-5` 就是完整 ID。

### 7.3 赛道 A 实现（结构化输出 + Batch）

```ts
import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";

const client = new Anthropic();

const MoveAnswer = z.object({
  moves: z.string(),
});
const StateAnswer = z.object({
  state: z.string().length(54),
});

const answerFormat = task.output === "moves" ? MoveAnswer : StateAnswer;

const response = await client.messages.parse({
  model: "claude-opus-5",
  max_tokens: 32000,                    // thinking 也占 max_tokens，给足余量
  thinking: { type: "adaptive" },       // Opus 5 上默认就开，显式写更清楚
  output_config: {
    effort: "high",                     // low | medium | high | xhigh | max
    format: zodOutputFormat(answerFormat),
  },
  system: [{
    type: "text",
    text: RULES_PROMPT,                 // ~1500 tokens，所有任务共享
    cache_control: { type: "ephemeral" }, // 关键：缓存
  }],
  messages: [{ role: "user", content: taskPrompt }],
});

const answer = response.parsed_output; // 再走 task-specific 领域校验，不用非空断言掩盖 refusal/截断
```

**三个必须做对的点：**

1. **`cache_control` 打在 system 上。** 系统提示词（记号约定 + facelet 编号图）在所有任务间完全相同，缓存读只要 0.1× 价格。Opus 5 的最小可缓存前缀是 512 tokens（Sonnet 5 是 1024），我们的规则提示词远超这个门槛。
   ⚠️ 缓存是**前缀精确匹配**——system 里绝不能插入时间戳、任务 ID、随机数，否则每次都是 cache miss。任务相关的一切都放到 `messages` 里。

2. **`max_tokens` 给足。** Opus 5 上 thinking 默认开启，且 thinking token 计入 `max_tokens`。按老模型的经验值设 4096 会导致答案被截断在思考中途（`stop_reason: "max_tokens"`）。

3. **大 `max_tokens` 用 Batch 或 streaming。** 非流式高 `max_tokens` 有 HTTP 超时风险。评测跑批用 Batch API 是最优解：**成本减半**，且没有超时问题。

**Batch 跑批：**

```ts
const batch = await client.messages.batches.create({
  requests: tasks.map(t => ({
    custom_id: t.id,
    params: { model: "claude-opus-5", max_tokens: 32000, /* ... */ },
  })),
});

// 轮询直到 processing_status === "ended"，然后：
for await (const r of await client.messages.batches.results(batch.id)) {
  // 结果顺序不保证 —— 必须按 custom_id 索引，不能按位置
  results.set(r.custom_id, r);
}
```

单批上限 10 万请求 / 256MB，多数 1 小时内完成，最长 24 小时。

### 7.4 ⚠️ 关于方差控制的重要说明

**当前模型（Opus 5 / Sonnet 5 / Fable 5 / Opus 4.7+）不接受 `temperature`、`top_p`、`top_k`——传了直接 400。**

这对 benchmark 设计有直接影响：

- **不能用 `temperature=0` 求确定性。**（顺带一提，即使在老模型上它也从来不保证逐字一致。）
- 方差控制的唯一手段是**重复采样**：每个任务跑 n≥3 次，报告 `pass@1` 均值 + 标准差，而不是单次结果。
- `effort` 成了核心可调维度。建议做一次完整的 effort 扫描（`low`/`medium`/`high`/`xhigh`），因为在 Opus 5 上 `low`/`medium` 的表现出奇地好——「更高 effort = 更好分数」在这一代模型上不成立，需要实测。

**这条要写进报告方法论章节**，否则读者会问"你们 temperature 设的多少"。

### 7.5 赛道 B 实现（工具循环）

```ts
import { betaZodTool } from "@anthropic-ai/sdk/helpers/beta/zod";

const applyMoves = betaZodTool({
  name: "apply_moves",
  // 描述要说清楚"什么时候用"，不只是"这是什么"
  description:
    "Apply a sequence of moves to the cube and return the resulting state. " +
    "Call this whenever you want to execute moves or verify your reasoning " +
    "against the real cube. Moves must be space-separated HTM notation.",
  inputSchema: z.object({
    expected_state: z.string().describe(
      "The 54-char facelet string you predict will result. Required."
    ),
    moves: z.string(),
  }),
  run: async ({ moves, expected_state }) => {
    env.consumeToolCall("apply_moves");           // 非法调用也计入 30 次
    const parsed = parseMoves(moves);            // 非法即抛错，计入指标
    env.assertMoveBudget(parsed.length);          // 超限则整段零提交
    env.applySequence(parsed);
    const after = env.state.toFacelets();
    env.recordHallucination(expected_state !== after);   // ← 幻觉率观测点
    return JSON.stringify({
      state: after, solved: env.isSolved(),
      moves_applied: env.totalMoves,
      budget_remaining: {
        tool_calls: env.maxToolCalls - env.toolCalls,
        moves: env.maxMoves - env.totalMoves,
      },
    });
  },
});

const runner = client.beta.messages.toolRunner({
  model: "claude-opus-5",
  max_tokens: 32000,
  thinking: { type: "adaptive" },
  output_config: {
    effort: "high",
    // 给 agent 一个 token 预算，让它自己知道要收尾
    task_budget: { type: "tokens", total: 120_000 },
  },
  betas: ["task-budgets-2026-03-13"],
  system: [{ type: "text", text: RULES_PROMPT, cache_control: { type: "ephemeral" } }],
  tools: [applyMoves, getState],
  messages: [{ role: "user", content: taskPrompt }],
  max_iterations: 32, // transport fuse，不是 max_tool_calls
});

// 迭代而非直接 await：每轮都能记录完整 transcript 和 usage
for await (const message of runner) {
  trace.push(message);
  usage.accumulate(message.usage);
  if (env.isSolved() || env.overBudget()) break;
}
```

`task_budget` 是**建议性**预算（模型能看到倒计时，会自己收尾），`max_tokens` 是**强制**上限。两者配合：前者让 agent 优雅收尾，后者兜底。最小值 20,000。`max_iterations` 只是 SDK 循环保险丝；真实 30-call/300-move 限制必须包住 `apply_moves` 和 `get_state` 的共同 capability gateway，并在 trace 中逐次记录 counter。若 SDK 默认并行执行同一轮的多个 tool call，adapter 必须关闭并行或自行按 block 顺序调度。

### 7.6 赛道 T6 实现（视觉）

```ts
messages: [{
  role: "user",
  content: [
    { type: "image", source: { type: "base64", media_type: "image/png", data: imgFrontUpRight }},
    { type: "image", source: { type: "base64", media_type: "image/png", data: imgBackDownLeft }},
    { type: "text", text: VISION_TASK_PROMPT },
  ],
}]
```

Opus 5 / Sonnet 5 支持长边 2576px 的高分辨率输入（单图最多约 4784 token）。魔方图案简单，**1024px 足够且省 3 倍 token**。先用 `countTokens` 实测一遍再定分辨率。

### 7.7 成本预估

假设：system 1500 tokens（缓存）+ 任务 300 tokens 输入，输出（含 thinking）平均 6000 tokens。

**赛道 A**（600 个任务）：

| 模型 | 单任务 | 600 任务 | Batch（-50%） |
|---|---|---|---|
| Opus 5 | ~$0.152 | ~$91 | **~$46** |
| Sonnet 5 | ~$0.092 | ~$55 | **~$28** |
| Haiku 4.5 | ~$0.031 | ~$19 | **~$9** |

**赛道 B**（100 个任务，30 轮工具调用，累计输入 ~400K 缓存读 + 输出 60K）：

- Opus 5：单任务 ~$1.7 → 100 任务 ~$170
- 没有缓存的话这个数字要翻 3–4 倍——**prompt caching 在 agentic 赛道上不是优化，是必需品**

跑批前用 `client.messages.countTokens()` 对代表性样本实测，别拍脑袋。

### 7.8 工程注意事项

- **错误处理要分链，不要一个 `catch` 兜底。** `NotFoundError`（模型 ID 打错）→ `RateLimitError`（退避重试）→ `APIStatusError` → `APIConnectionError`，各自处理。SDK 默认自动重试 429/5xx 两次。
- **`stop_reason` 必须在读 `content` 之前检查。** Opus 5 有安全分类器可能返回 `stop_reason: "refusal"`（HTTP 200，`content` 为空）。魔方任务几乎不可能触发，但代码里 `content[0].text` 无脑取值会在那 0.01% 的情况下崩掉整个跑批。同时 `max_tokens` 截断也要单独识别并计入指标（是"没答完"而不是"答错了"）。
- **断点续跑。** 结果按 `task_id` 写 JSONL append-only，重启时跳过已完成的。跑几百个任务时这是刚需。
- **并发限制。** 按 tier 的 RPM/TPM 限速；注意 **Opus 5 有独立的 rate limit 池**，不和 Opus 4.x 共用。
- **API key 不进浏览器。** 游戏内的"AI 演示"功能必须走 `server/` 里的轻量代理，前端只发任务不发 key。

---

## 8. 里程碑

| 阶段 | 内容 | 产出 |
|---|---|---|
| **M0** | `cube-core`：状态、move、facelet、合法性校验、种子打乱 | 单测覆盖率 >90%，含四条不变量的性质测试 |
| **M1** | `cube-render`：静态渲染 + 转层动画 + 拖拽交互 | 手感可用的 3D 魔方 |
| **M2** | `app`：计时器、统计、打乱显示、键盘 | 可日常玩的速拧计时器 |
| **M2.5** | 已提交历史、Undo 与倒带 | 练习公式时可安全撤销；WebGL/fallback 语义一致 |
| **M3a** | 坐标、移动表、剪枝表、版本化 artifact/cache 契约与冷启动实测 | 决定 Worker 生成缓存还是打包二进制资产 |
| **M3b** | Kociemba 两阶段搜索、确定性评测 profile 与 Worker 客户端 | 游戏内自动复原；可重复计算距离代理 |
| **M3c** | k≤9 双向最优搜索（Node/bench only） | `optimality_ratio` 可算 |
| **M3d** | 距离代理验证 profile：相关性、误差、逆序、局部一致性与 coverage | 确认或否决 `progress_score` 的 Kociemba 实现 |
| **M3.5** | 七阶段 LBL、公式库、高亮与教程 UI | 跟练、提示、演示三种教学模式 |
| **M4** | `bench`：任务生成、Anthropic 适配器、赛道 A、Batch 跑批 | 第一份 T1/T3 评测报告 |
| **M5** | 赛道 B 工具循环、T6 视觉任务、HTML 聚合报告 | 完整 benchmark v1 |

**M0 → M3a → M3b → M3d 是关键路径**：M3b 只提供候选距离代理，必须经过 M3d 才能进入正式指标。M2.5 与 M3.5 扩展人类可玩目标，但不阻塞 benchmark；M3c 只阻塞短打乱的真最优校准。

**当前状态（2026-08-17）：** M3a 的坐标、表生成、严格 artifact 校验和注入式 cache API 已完成；本机 Node 22 / WSL2 三次冷进程生成中位数为 856.59 ms。目标桌面浏览器、移动设备、Node CI、IndexedDB/cache-hit 与资产 I/O 的 P50/P95 尚未测量，所以 M3a 的 A/B 决策门仍未关闭，不能提前进入某一种资产形态。

---

## 9. 风险与待决问题

| 风险 | 影响 | 缓解 |
|---|---|---|
| Kociemba 表只有单机 Node 冷进程基线，缺跨端 P50/P95、持久化/cache-hit 与资产 I/O 数据 | 首次使用的真实等待和发布体积仍不确定 | M3a 在目标桌面浏览器、移动设备和 Node CI 分别补齐基准；超过阈值则打包带版本校验的二进制资产，否则 Worker 生成并缓存 |
| Facelet 约定歧义导致模型"被冤枉" | 分数系统性偏低，结论无效 | 系统提示词内嵌展开图；**跑一个"复原态识别"哨兵任务**——如果模型连复原态都读不对，说明是约定问题不是能力问题 |
| 训练数据污染（魔方教程海量存在） | 分数虚高 | held-out 种子集 + 随机状态打乱；T1 状态预测受污染影响最小，作为主信号 |
| 移动端 60fps 达不到 | 手感崩 | 圆角段数可降级；关闭环境贴图；按需渲染 |
| `effort` 扫描把成本乘以 4 | 预算爆炸 | 先用 Sonnet 5 + Batch 做 effort 扫描定档位，再用定好的档位跑 Opus 5 |

**待决问题（需要先做实验才能定）：**

1. `progress_score` 用 Kociemba 解长度是否足够可靠？唯一的 M3d manifest 固定语料类别（已知真距离、模型实际轨迹、相邻状态对）、seed、solver/table fingerprint、`hardMax`、`targetLength`、`maxNodes`、canonical move order、节点计数规则版本、最低 coverage 与 go/no-go 阈值，并统一报告 Spearman ρ、MAE、逆序率、最短解方向一致率及 `|d(s)-d(s·m)| > 1` 的 Lipschitz 违规率；无方向随机游走只作对照，不要求单调。如果噪声超过预设阈值，整体切换到角块/棱块 PDB 下界或组合指标，不能在同一指标版本里逐样本混用。
2. 赛道 B 的 30 次工具调用上限是否合理？先跑 10 个任务看分布再定。
3. 三种表示（facelet / JSON / ASCII）要不要都跑？成本 ×3。建议先在 Haiku 上做小样本对照，如果差异 <5% 就只保留 facelet。
4. T6 视觉任务两张图够不够覆盖 54 格？等轴测双视角理论上能看到全部 6 面，但边缘格子透视变形严重——可能需要三视角或正交投影。

---

## 10. 附录：系统提示词骨架

```
You are solving a standard 3x3x3 Rubik's Cube.

## Notation
Moves are single letters U, D, L, R, F, B meaning a 90° clockwise turn of that
face (viewed from outside that face). A trailing ' means counter-clockwise.
A trailing 2 means 180°. Only these 18 moves are valid:
U U' U2 D D' D2 L L' L2 R R' R2 F F' F2 B B' B2

## State encoding
The cube state is a 54-character string. Each character is a face letter
(U/R/F/D/L/B) naming which face that sticker's color belongs to.
Facelets are numbered as follows:

             ┌─────────┐
             │ 0  1  2 │
             │ 3  4  5 │
             │ 6  7  8 │
   ┌─────────┼─────────┼─────────┬─────────┐
   │36 37 38 │18 19 20 │ 9 10 11 │45 46 47 │
   │39 40 41 │21 22 23 │12 13 14 │48 49 50 │
   │42 43 44 │24 25 26 │15 16 17 │51 52 53 │
   └─────────┼─────────┴─────────┴─────────┘
             │27 28 29 │
             │30 31 32 │
             │33 34 35 │
             └─────────┘

String order: U(0-8), R(9-17), F(18-26), D(27-35), L(36-44), B(45-53).
Centers (indices 4, 13, 22, 31, 40, 49) never move.
The solved state is:
UUUUUUUUURRRRRRRRRFFFFFFFFFDDDDDDDDDLLLLLLLLLBBBBBBBBB
```

> 提示词写作注意：**不要写 `CRITICAL: You MUST...` 这类高压语气**。当前模型对系统提示词的遵循度很高，为老模型写的强调语气会导致过度触发和行为僵化。平铺直叙即可。同理，不要加"think step by step"——thinking 是 API 参数不是咒语，用 `effort` 控制深度。

---

## 11. 参考

- Kociemba 两阶段算法：https://kociemba.org/cube.htm
- God's Number = 20 (HTM) / 26 (QTM)
- WCA 规则（计时、观察时间、+2/DNF 判罚）
- Anthropic API：结构化输出、prompt caching、Batch API、tool use
