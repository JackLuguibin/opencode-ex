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

## CI 状态

GitHub Actions 暂停，所有工作流已移至 `.github/workflows-disabled/`。重新启用前需要适配本仓库的分支、runner 与部署目标；本地检查和推送钩子仍保留。

## 官网裁剪范围

保留 `services/www` 的 V2 使用说明、API 参考、搜索与 schema，以及 `packages/web` 的 V1 文档和配图。官网首页跳转文档。

移除营销首页、品牌和下载展示、Enterprise/Zen/Go 推广页、官方法律及社区跳转页、销售表单及集成、独立文章和更新日志站点。保留 Web 应用、模型/Agent 后端、会话分享、文档代理和 CLI 分发/更新基础设施。

## 桌面端拆除范围

- 移除 `packages/desktop` 和桌面端 Nix 构建定义。
- 移除桌面开发命令、Turbo 桌面测试任务与 Electron 启动基准测试。
- Web 需要的图标迁移至 `packages/app/icons`，同步更新图标构建及测试路径。
- 上游发布流水线的桌面开关固定关闭；保留上游发布辅助脚本以便后续同步。
- 移除桌面 SSH、WSL、更新、配对、原生浏览器插件及 Electron 内存诊断。
- 移除 Electron 依赖和原生窗口、嵌入视图、菜单 SDK API；保留通用存储、IPC 与 Web 使用的可选契约。
- 桌面发布工作流已归档停用，专用发布和 macOS 签名脚本已删除。

本地已使用 Bun 1.4.4 安装依赖，并验证后端启动、Web 密码登录及主界面加载。桌面插件清理后，完整 lint/类型检查（34 项任务）、114 个 GUI 插件测试、232 个 Web 浏览器环境测试、2 个插件加载测试及 30 个插件宿主/组合浏览器测试通过。尚未验证模型调用、生产构建、完整 E2E 或 Nix 依赖哈希刷新。测试环境说明见 `LOCAL_TEST.md`。

---

以下为上游 README：

<p align="center">
  <a href="https://opencode.ai">
    <picture>
      <source srcset="packages/console/app/src/asset/logo-ornate-dark.svg" media="(prefers-color-scheme: dark)">
      <source srcset="packages/console/app/src/asset/logo-ornate-light.svg" media="(prefers-color-scheme: light)">
      <img src="packages/console/app/src/asset/logo-ornate-light.svg" alt="OpenCode logo">
    </picture>
  </a>
</p>
<p align="center">The open source AI coding agent.</p>
<p align="center">
  <a href="https://opencode.ai/discord"><img alt="Discord" src="https://img.shields.io/discord/1391832426048651334?style=flat-square&label=discord" /></a>
  <a href="https://www.npmjs.com/package/@opencode/cli"><img alt="npm" src="https://img.shields.io/npm/v/@opencode/cli?style=flat-square" /></a>
  <a href="https://github.com/anomalyco/opencode/actions/workflows/release.yml"><img alt="Build status" src="https://img.shields.io/github/actions/workflow/status/anomalyco/opencode/release.yml?style=flat-square&branch=dev" /></a>
</p>

<p align="center">
  <a href="README.md">English</a> |
  <a href="README.zh.md">简体中文</a> |
  <a href="README.zht.md">繁體中文</a> |
  <a href="README.ko.md">한국어</a> |
  <a href="README.de.md">Deutsch</a> |
  <a href="README.es.md">Español</a> |
  <a href="README.fr.md">Français</a> |
  <a href="README.it.md">Italiano</a> |
  <a href="README.da.md">Dansk</a> |
  <a href="README.ja.md">日本語</a> |
  <a href="README.pl.md">Polski</a> |
  <a href="README.ru.md">Русский</a> |
  <a href="README.bs.md">Bosanski</a> |
  <a href="README.ar.md">العربية</a> |
  <a href="README.no.md">Norsk</a> |
  <a href="README.br.md">Português (Brasil)</a> |
  <a href="README.th.md">ไทย</a> |
  <a href="README.tr.md">Türkçe</a> |
  <a href="README.uk.md">Українська</a> |
  <a href="README.bn.md">বাংলা</a> |
  <a href="README.gr.md">Ελληνικά</a> |
  <a href="README.vi.md">Tiếng Việt</a>
</p>

[![OpenCode Terminal UI](packages/web/src/assets/lander/screenshot.png)](https://opencode.ai)

---

### Installation

```bash
# YOLO
curl -fsSL https://opencode.ai/v2/install | bash

# Package managers
npm i -g @opencode/cli@latest      # or bun/pnpm/yarn
brew install anomalyco/tap/opencode-v2 # macOS and Linux (recommended, always up to date)
brew install opencode              # macOS and Linux (official brew formula, updated less)
sudo pacman -S opencode            # Arch Linux (Stable)
paru -S opencode-beta              # Arch Linux (Latest from AUR)
mise use -g opencode               # Any OS
nix run github:anomalyco/opencode  # Nix
```

> [!TIP]
> Remove versions older than 0.1.x before installing.

### Desktop App (BETA)

OpenCode is also available as a desktop application. Download it from [opencode.ai/download](https://opencode.ai/download).

| Platform              | Download                           |
| --------------------- | ---------------------------------- |
| macOS (Apple Silicon) | `opencode-desktop-mac-arm64.dmg`   |
| macOS (Intel)         | `opencode-desktop-mac-x64.dmg`     |
| Windows               | `opencode-desktop-win-x64.exe`     |
| Linux                 | `.deb`, `.rpm`, or `.AppImage`     |

```bash
# macOS (Homebrew)
brew install --cask opencode-desktop
```

#### Installation Directory

The install script installs OpenCode to `$HOME/.opencode/bin`.

### Agents

OpenCode includes two built-in agents you can switch between with the `Tab` key.

- **build** - Default, full-access agent for development work
- **plan** - Read-only agent for analysis and code exploration
  - Denies file edits by default
  - Asks permission before running bash commands
  - Ideal for exploring unfamiliar codebases or planning changes

Also included is a **general** subagent for complex searches and multistep tasks.
This is used internally and can be invoked using `@general` in messages.

Learn more about [agents](https://opencode.ai/v2/docs/agents).

### Documentation

For more info on how to configure OpenCode, [**head over to our docs**](https://opencode.ai/v2/docs).

### Contributing

If you're interested in contributing to OpenCode, please read our [contributing docs](./CONTRIBUTING.md) before submitting a pull request.

### Building on OpenCode

If you are working on a project that's related to OpenCode and is using "opencode" as part of its name, for example "opencode-dashboard" or "opencode-mobile", please add a note to your README to clarify that it is not built by the OpenCode team and is not affiliated with us in any way.

---

**Join our community** [Discord](https://discord.gg/opencode) | [X.com](https://x.com/opencode)
