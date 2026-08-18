# 部署（Vercel）

产物是**纯静态站点**：4 个文件、约 800 KB，没有后端、没有环境变量、没有客户端路由。
只有一个 `index.html`，也没有前端路由，所以不需要 SPA history fallback。

## 一次性设置

仓库根目录的 `vercel.json` 已经写好了构建配置，连接仓库后**面板里不用手填任何东西**：

| 项 | 值 | 来源 |
| --- | --- | --- |
| Framework preset | None | `vercel.json` 的 `"framework": null` |
| Install command | `pnpm install --frozen-lockfile` | `vercel.json` |
| Build command | `pnpm -r build` | `vercel.json` |
| Output directory | `dist`（仓库根目录） | `vercel.json`，且与平台默认值一致 |
| Node 版本 | `>=22.12` | 根 `package.json` 的 `engines.node` |
| 包管理器 | pnpm 10.15.0 | 根 `package.json` 的 `packageManager`，经 corepack |

唯一要在面板里确认的是 **Root Directory 保持仓库根目录**（默认值），不要改成 `packages/app`。

产物**输出在仓库根目录的 `dist/`**，不是 `packages/app/dist`。这是刻意的：Vercel 找不到
`outputDirectory` 时默认就去找根目录下的 `dist`，两者对齐之后，即使 `vercel.json` 因为
Root Directory 设置不当而没被读到，构建仍然能被正确发布。`packages/app/vite.config.ts` 里用
`build.outDir: '../../dist'` 实现。

**为什么必须是根目录**：`@rubcube/app` 依赖 `@rubcube/cube-core` 与 `@rubcube/cube-render`
两个 workspace 包，它们要先 `tsc` 出 `dist/` 才能被打包。`pnpm -r build` 会按依赖拓扑序依次
构建 core → render → app；只在 `packages/app` 里跑 `vite build` 会因为找不到依赖产物而失败。

## 缓存策略

`vercel.json` 的 `headers` 定死两条：

- `/index.html`（以及 `/`）— `max-age=0, must-revalidate`
- `/assets/*` — `max-age=31536000, immutable`

`index.html` 是唯一一个**文件名跨构建不变**的文件。它一旦被缓存，就会继续指向已经不存在的
带哈希资源名，部署后用户看到白屏。`/assets/*` 反过来，每个 URL 的内容永不改变，可以缓存一年。

这两条是显式写出来的，没有依赖平台默认值：`framework` 为 `null` 时 Vercel 不会套用任何框架
预设的缓存规则。

`packages/app/public/_headers` 里有一份等价规则。Vercel 不读它，留着是为了将来若改用
Cloudflare Pages 或 Netlify 时缓存行为不变——那两家读这个文件，且 Vite 会把它复制进产物。

## 部署前自检

```bash
pnpm -r typecheck && pnpm -r test && pnpm -r build
```

再用一个最普通的静态服务器验证产物本身。不要用 `vite preview`：它有自己的中间件，
证明不了产物在纯静态托管下能跑。

```bash
cd dist && python3 -m http.server 5399
```

打开 http://127.0.0.1:5399/ ，应当看到 WebGL 渲染的魔方、`SOLVED` 徽章，控制台无报错。

## 首次部署后要人工确认的

`vercel.json` 的字段是按 Vercel 文档写的，但**本地无法验证平台实际行为**。首次部署后查一次：

```bash
curl -sI https://<你的域名>/ | grep -i cache-control
curl -sI https://<你的域名>/assets/<任一带哈希文件> | grep -i cache-control
```

前者应当是 `max-age=0, must-revalidate`，后者应当是 `max-age=31536000, immutable`。
