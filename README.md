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

M3a 的核心代码已经落地：`@rubcube/cube-core/solver` 现在提供六种 Kociemba 坐标、6 张移动表、4 张 nibble 剪枝表、版本化二进制 artifact 和注入式缓存加载。四张表的 9/9/14/12 直径已由穷举测试固定。当前仍缺目标桌面浏览器和移动设备上的决策级冷路径基准，因此 Worker 生成缓存与打包资产之间尚未选型；M3b 的两阶段搜索、Worker 和自动求解 UI 也尚未实现。

## 开发

需要 Node.js 22+ 和 Corepack；无需全局安装 `pnpm`：

```sh
corepack pnpm install
corepack pnpm -r test
corepack pnpm -r typecheck
corepack pnpm -r coverage
corepack pnpm -r build
```

运行单进程 Node 表基准：

```sh
corepack pnpm --filter @rubcube/cube-core bench:tables
```

这条命令输出可归档的 JSON；当前仓库的 [`solver-tables-node-wsl2-2026-08-17.json`](packages/cube-core/benchmarks/solver-tables-node-wsl2-2026-08-17.json) 只是单机 Node 冷进程基线，不是方案 A/B 的跨端决策报告。

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

`generateRandomState` 等概率抽取满足魔方四项不变量的可达状态。操作台当前使用设计中的种子化 25 步回退打乱；完整 WCA 打乱序列还需要 M3b 的两阶段搜索与 Worker 集成：求解随机状态，再将解序列逆序。
