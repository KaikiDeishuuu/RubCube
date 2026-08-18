# 部署

产物是**纯静态站点**：4 个文件、约 800 KB，没有后端、没有环境变量、没有客户端路由。
任何静态托管都能跑，不需要 SPA history fallback（只有一个 `index.html`，也没有 `/tutorial`
之类的前端路由——那还没实现）。

## 三个平台通用的设置

| 项 | 值 |
| --- | --- |
| Root directory | 仓库根目录（**不是** `packages/app`） |
| Build command | `pnpm -r build` |
| Output directory | `packages/app/dist` |
| Node 版本 | 由 `.node-version`（Cloudflare Pages / Netlify）与 `engines.node`（Vercel）指定 |
| 包管理器 | 由根 `package.json` 的 `packageManager` 字段经 corepack 固定为 pnpm 10.15.0 |

**Root directory 必须是仓库根目录。** `@rubcube/app` 依赖 `@rubcube/cube-core` 与
`@rubcube/cube-render` 两个 workspace 包，它们要先 `tsc` 出 `dist/` 才能被打包。
`pnpm -r build` 会按依赖拓扑序依次构建 core → render → app；只在 `packages/app` 里跑
`vite build` 会因为找不到依赖产物而失败。

## 各平台

### Cloudflare Pages
- Framework preset: **None**
- 其余按上表填。`_headers` 自动生效。

### Netlify
- 按上表填。`_headers` 自动生效。
- 也可以改用 `netlify.toml`，但目前没加——上表三个字段在面板里填一次就够了。

### Vercel
- Framework preset: **Other**
- 按上表填。Vercel 不读 `_headers`；它对带内容哈希的 `/assets/*` 默认就是长缓存，
  `index.html` 默认不缓存，行为与 `_headers` 想要的一致。若之后需要显式控制，再加 `vercel.json`。

## 缓存策略

`packages/app/public/_headers` 定死两条：

- `/index.html` — `max-age=0, must-revalidate`
- `/assets/*` — `max-age=31536000, immutable`

`index.html` 是唯一一个**文件名跨构建不变**的文件。它一旦被缓存，就会继续指向已经不存在的
带哈希资源名，部署后用户看到白屏。`/assets/*` 反过来，每个 URL 的内容永不改变，可以缓存一年。

## 部署前自检

```bash
pnpm -r typecheck && pnpm -r test && pnpm -r build
```

再用一个最普通的静态服务器验证产物本身（不要用 `vite preview`，它有自己的中间件，
证明不了产物在纯静态托管下能跑）：

```bash
cd packages/app/dist && python3 -m http.server 5399
```

打开 http://127.0.0.1:5399/ ，应当看到 WebGL 渲染的魔方、`SOLVED` 徽章，控制台无报错。

## 尚未接入

仓库目前**没有 git remote**，也没有 CI。静态托管平台需要连接一个 Git 仓库才能自动构建；
先创建远程仓库并推送，再在平台上连接。
