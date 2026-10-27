# opencode-ex

从 OpenCode 提取的 Web 应用独立仓库。来源提交与提取范围见 `UPSTREAM.json`，保留上游 MIT 许可证。

## 目录

- `packages/app`：SolidJS / Vite Web 应用。
- 其余 workspace 包：Web 应用的本地直接及传递依赖（含开发工具）。
- `packages/desktop/icons`：Web 构建使用的图标资源，不包含桌面应用。
- `packages/stories/playwright`：现有组件测试使用的公共辅助文件。

完整上游源码和 Git 历史保存在同级 `../opencode-base`。

## 运行

使用 `package.json` 中指定的 Bun 版本（1.4.4）。

```sh
bun install
bun run dev
```

默认前端地址为 `http://localhost:3000`，开发模式连接 `http://localhost:4096` 的 OpenCode 服务。可设置 `VITE_OPENCODE_SERVER_HOST`、`VITE_OPENCODE_SERVER_PORT`，或在界面中添加服务器。

```sh
bun run build
bun run preview
```

本仓库不包含 CLI、服务端实现和官网文档站（`packages/web`）。使用已有 OpenCode 服务，或从 `../opencode-base` 启动后端。服务端联调及 E2E 脚本中保留的上游后端路径需要完整仓库；它们不属于本仓库的独立前端运行范围。

尚未安装依赖或验证构建；当前环境未提供 Bun。
