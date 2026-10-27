# opencode-ex

基于完整 OpenCode 仓库，移除 Electron 桌面应用及官网营销内容。保留 Web 应用、CLI、服务端、TUI、SDK、插件和 V1/V2 使用说明文档。完整上游副本位于同级 `../opencode-base`，来源提交见 `UPSTREAM.json`。

## 本地运行

使用 Bun 1.4.4，在根目录安装依赖：

```sh
bun install
```

分别在两个终端启动后端与 Web 前端：

```sh
bun dev serve --port 4096
```

```sh
bun run dev:web
```

Web 默认地址为 `http://localhost:3000`。CLI / TUI 使用 `bun dev`，Web 构建使用 `bun run --cwd packages/app build`。

## 上游业务残留清理

已移除 Salesforce、官方统计站点及代理、Enterprise 反向代理和官方登录跳转、桌面更新接口、上游专用脚本与无引用截图。保留核心用量统计、CLI 更新查询与文件下载。云配置仅保留 ex 的 Cloudflare 资源；自定义域名通过环境变量配置，见 [部署说明](infra/README.md)。

## 本轮残留清理

已删除退役分享 Worker、官方 iOS 关联、旧仓库维护者名单、上游发布签名及 Issue/PR 自动管理脚本。CLI 本地构建与打包命令仍保留。

官网 OpenAPI 直接读取本仓库协议文件。文档代理仅连接 ex 自身的文档服务：开发模式默认 V1 `http://127.0.0.1:4321`、V2 `http://127.0.0.1:3000`；生产构建通过 `VITE_OPENCODE_EX_V1_DOCS_URL` 和 `VITE_OPENCODE_EX_V2_DOCS_URL` 配置，未配置返回 503。首页进入 V2 文档。

## CI 状态

GitHub Actions 暂停，所有工作流已移至 `.github/workflows-disabled/`。重新启用前需要适配本仓库的分支、runner 与部署目标；本地检查和推送钩子仍保留。

## 官网裁剪范围

保留 `services/www` 的 V2 使用说明、API 参考、搜索与 schema，以及 `packages/web` 的 V1 文档和配图。官网首页跳转文档。

移除营销首页、品牌和下载展示、Enterprise/Zen/Go 推广页、官方法律及社区跳转页、销售表单及集成、独立文章和更新日志站点。保留 Web 应用、模型/Agent 后端、文档代理和 CLI 分发/更新基础设施。

## 桌面端拆除范围

- 移除 `packages/desktop` 和桌面端 Nix 构建定义。
- 移除桌面开发命令、Turbo 桌面测试任务与 Electron 启动基准测试。
- Web 需要的图标迁移至 `packages/app/icons`，同步更新图标构建及测试路径。
- 上游发布流水线的桌面开关固定关闭；保留上游发布辅助脚本以便后续同步。
- 移除桌面 SSH、WSL、更新、配对、原生浏览器插件及 Electron 内存诊断。
- 移除 Electron 依赖和原生窗口、嵌入视图、菜单 SDK API；保留通用存储、IPC 与 Web 使用的可选契约。
- 桌面发布工作流已归档停用，专用发布和 macOS 签名脚本已删除。

本地已使用 Bun 1.4.4 安装依赖，并验证后端启动、Web 密码登录及主界面加载。桌面插件清理后，完整 lint/类型检查（34 项任务）、114 个 GUI 插件测试、232 个 Web 浏览器环境测试、2 个插件加载测试及 30 个插件宿主/组合浏览器测试通过。尚未验证模型调用、生产构建、完整 E2E 或 Nix 依赖哈希刷新。测试环境说明见 `LOCAL_TEST.md`。

## 中文说明

- [上游简体中文说明](README.zh.md)
- [上游繁體中文說明](README.zht.md)
