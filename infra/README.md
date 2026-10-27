# ex 部署配置

SST 配置仅声明 Cloudflare 资源，应用名为 `opencode-ex`。保留 Web 前端、文档与分享入口以及 GitHub App API；不包含官方统计站点、Enterprise 代理、历史 Zen 桶或 AWS、Stripe、PlanetScale 配置。

自定义域名均由部署者提供；未设置时使用 Cloudflare 分配的地址：

- `OPENCODE_EX_DOMAIN`：文档代理入口；API 与 V1 文档使用其 `api.` 和 `docs.` 子域名。
- `OPENCODE_EX_WEB_DOMAIN`：Web 前端。
- `OPENCODE_EX_SHARE_DOMAIN`：会话分享服务。

GitHub App API 仍需要部署者配置自己的 `GITHUB_APP_ID`、`GITHUB_APP_PRIVATE_KEY` 和 `ADMIN_SECRET`。

本轮只修改源码，未部署或变更任何线上资源。首次使用这套配置前，需要配置自己的 Cloudflare 账号、状态存储和域名，再检查部署计划。V2 文档及 CLI 分发/更新服务仍有各自的 Wrangler 配置，使用前也需要改为自己的绑定和资源。

GitHub Actions 继续关闭。
