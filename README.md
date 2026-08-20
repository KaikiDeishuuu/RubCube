# RubCube

Web 魔方游戏与 LLM 空间推理评测平台。实现以 [DESIGN.md](./DESIGN.md) 为准。

当前已完成 M0 的 `@rubcube/cube-core`：

- Kociemba 顺序的 cubie 状态与完整可达性校验
- 严格的 18 种 HTM 记号解析、反转和状态应用
- cubie 与 URFDLB 54 字符 facelet 双向转换
- 可复现的 `mulberry32`、随机可达状态和受约束随机步打乱
- 浏览器与 Node.js 共用的零运行时依赖 TypeScript API

以及 M1 的 `@rubcube/cube-render` 和 `@rubcube/app`：

- 26 个稳定身份的小方块、共享圆角几何体和每块一次绘制的塑料质感渲染
- 由整数 `CubeState` 驱动的 pivot 转层动画、拖层跟手与 30° 吸附/回弹
- 轨迹球相机、csTimer 风格键位、空闲停绘、像素比上限和 reduced-motion 支持
- WebGL2 不可用或上下文丢失时，自动保留当前状态并降级到可访问的 SVG 展开图
- React + Zustand 操作台：公式播放、种子化 25 步打乱、复原、18 个 HTM 按钮和响应式布局

M2.5 的历史与回放运行路径也已经接通：

- `@rubcube/cube-render/transport` 统一处理 provenance、批次提交、命令终态、取消、deferred FIFO、revision 与 fatal 隔离
- WebGL `TurnAnimator` 和 2D fallback 都实现同一 backend 契约；fallback 每个 macrotask 最多提交一步，可在 batch 边界取消
- app 使用 `baseState + entries` 原子维护已提交历史，界面已提供 Undo、完整倒带和取消播放；Reset/打乱也经过同一 dispatcher
- WebGL 上下文丢失时从最后一个已提交整数状态切换到 fallback，不读取动画中的浮点瞬时状态

求解器已经落地到 M3d：

- **M3a** —— `@rubcube/cube-core/solver` 提供六种 Kociemba 坐标、6 张移动表、4 张 nibble 剪枝表、版本化二进制 artifact 和注入式缓存加载。四张表的 9/9/14/12 直径由穷举测试固定。桌面浏览器冷路径已实测（冷生成 P95 726 ms），**方案 B（首次在 Worker 生成、存 IndexedDB）已选定**；移动设备仍未测。
- **M3b** —— 两阶段搜索、可暂停内核、Worker、IndexedDB 表缓存和游戏内「Solve」按钮都已接通。10,000 个均匀随机状态全部求解成功，纯求解 P50 28.5 ms / P99 280 ms。唯一未达标的验收项是解长度中位数（21，标准是 ≤ 20）。
- **M3c** —— `@rubcube/cube-core/optimal` 用中间相遇搜索给出 k≤9 的**真最优解**，供 benchmark 的 `optimality_ratio` 当分母。它是 Node/bench 专用的：生产构建会遍历 Rollup 模块图，把它挡在浏览器包外面。

- **M3d** —— `@rubcube/cube-core/metrics` 提供 §6.5 的进度分，以及两份**预注册**验证 profile（语料、seed、solver profile 与 go/no-go 阈值一起散列成 fingerprint，事后调门槛会改掉指纹）。跑了两轮：

  - **第一轮否决**了「Kociemba 解长度当距离」。它在 10–21 步区间饱和——整整一个第一层做完，解长只从 20.68 走到 20.25，折算成进度分约 0.02。
  - **第二轮通过**了替代实现 `structural-cubies-v1`：`progress_score` 改成「位置与朝向都正确的块数占剩余工作的比例」。同一批状态上，底面十字 / 第一层 / 前两层 / 顶面定向分别是 0.24 / 0.44 / 0.64 / 0.70，层级 Spearman ρ 0.9765（旧代理 0.8254），每次打分 0.0006 ms 且不需要表。

  被否决的那一版连同它的脚本一起留在仓库里——没有它，「新的这版好在哪」就只是一句断言。详见 DESIGN-SOLVING.md 的两节「M3d 实测」。

尚未实现的是 M3.5 的分层教学。

## 开发

需要 Node.js 22+ 和 Corepack；无需全局安装 `pnpm`：

```sh
corepack pnpm install
corepack pnpm -r test
corepack pnpm -r typecheck
corepack pnpm -r coverage
corepack pnpm -r build
```

运行求解器的基准与验收语料（每条都输出可归档的 JSON，语料、seed 和 profile 全部写死在脚本里）：

```sh
corepack pnpm --filter @rubcube/cube-core bench:tables
```

```sh
corepack pnpm --filter @rubcube/cube-core verify:corpus
```

```sh
corepack pnpm --filter @rubcube/cube-core verify:optimal
```

两份指标验证 profile（判定为 no-go 时退出码为 1，那是实验给出的答案，不是脚本出错）：

```sh
corepack pnpm --filter @rubcube/cube-core validate:progress
```

```sh
corepack pnpm --filter @rubcube/cube-core validate:proxy
```

`bench:tables` 输出的 [`solver-tables-node-wsl2-2026-08-17.json`](packages/cube-core/benchmarks/solver-tables-node-wsl2-2026-08-17.json) 只是单机 Node 冷进程基线，不是方案 A/B 的跨端决策报告——那份决策证据来自浏览器实测，见 DESIGN-SOLVING.md §2.6。`verify:corpus` 跑 M3b 的 10,000 个均匀随机状态，`verify:optimal` 跑 M3c 的球层数量断言与 k=1..9 语料。

`-r` 不能省：根目录的 `test`、`build` 等脚本会再调用一次裸 `pnpm`，而 Corepack 只提供 `corepack pnpm` 这一个入口。执行过 `corepack enable` 生成全局垫片后，`pnpm test` 这类简写才可用。

工作区内部包额外导出了指向 `src` 的 `development` 条件，因此 `test`、`typecheck`、`coverage` 和下面的 dev server 都直接读源码，改完 `cube-core` 不必先 `build`；而 `tsc -p tsconfig.build.json` 与 `vite build` 仍走 `dist`，其先后由 `pnpm -r build` 的拓扑顺序保证。

启动当前交互操作台：

```sh
corepack pnpm --filter @rubcube/app dev
```

然后访问 <http://localhost:5173>。

## 核心 API

```ts
import {
  applyMoves,
  createSolvedState,
  fromFacelets,
  generateRandomMoves,
  generateRandomState,
  parseMoves,
  toFacelets,
} from '@rubcube/cube-core';

const solved = createSolvedState();
const moved = applyMoves(solved, "R U R' U'");
const encoded = toFacelets(moved);
const decoded = fromFacelets(encoded);

const shortScramble = generateRandomMoves(8, 20260817);
const randomState = generateRandomState(20260817);
```

`generateRandomState` 等概率抽取满足魔方四项不变量的可达状态。操作台当前使用种子化的 25 步回退打乱；改用完整 WCA 随机状态打乱只差把已有的 solver Worker 接进打乱路径——求解随机状态，再将解序列逆序。
