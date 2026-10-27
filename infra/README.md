# ex 部署配置

SST 配置仅声明 Cloudflare 资源，应用名为 `opencode-ex`。保留 Web 前端、文档入口以及 GitHub App API；不包含官方统计站点、Enterprise 代理、历史 Zen 桶或 AWS、Stripe、PlanetScale 配置。

自定义域名均由部署者提供；未设置时使用 Cloudflare 分配的地址：

- `OPENCODE_EX_DOMAIN`：文档代理入口；API 与 V1 文档使用其 `api.` 和 `docs.` 子域名。
- `OPENCODE_EX_WEB_DOMAIN`：Web 前端。
- `OPENCODE_EX_V2_DOCS_URL`：ex 自己部署的 V2 文档服务地址，部署官网代理时必须配置。

GitHub App API 仍需要部署者配置自己的 `GITHUB_APP_ID`、`GITHUB_APP_PRIVATE_KEY` 和 `ADMIN_SECRET`。

退役的分享 Worker 已删除；旧版分享页面仅保留为文档服务中的兼容页面路由，不再部署无数据存储能力的分享服务。

本轮只修改源码，未部署或变更任何线上资源。首次使用这套配置前，需要配置自己的 Cloudflare 账号、状态存储和域名，再检查部署计划。V2 文档及 CLI 分发/更新服务仍有各自的 Wrangler 配置，使用前也需要改为自己的绑定和资源。

GitHub Actions 继续关闭。

## 文档入口

本地开发时，官网代理使用 V1 `http://127.0.0.1:4321`、V2 `http://127.0.0.1:3000`。分别运行对应文档服务后即可通过代理访问；Web Agent 服务仍使用原有端口。

直接构建官网代理时，用 `VITE_OPENCODE_EX_V1_DOCS_URL` 和 `VITE_OPENCODE_EX_V2_DOCS_URL` 指定自己的文档服务。生产构建未配置时返回 503，不回退请求官方站点。通过 SST 构建时，V1 地址从 ex 的文档资源取得，V2 使用必填的 `OPENCODE_EX_V2_DOCS_URL`。

OpenAPI 从本仓库 `packages/protocol/openapi.json` 打包。站点 sitemap 的 canonical origin 可通过 `VITE_OPENCODE_EX_SITE_URL` 设置；robots 使用当前请求 origin。
