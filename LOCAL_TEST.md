# 本地测试环境

验证日期：2026-10-27。

- 前端：http://127.0.0.1:4444
- 后端：http://127.0.0.1:4096
- Bun 1.4.4：`/tmp/opencode-ex-tools/node_modules/.bin/bun`
- 测试数据与配置：`/tmp/opencode-ex-runtime`，与个人 OpenCode 数据隔离。

页面会直接连接 `http://127.0.0.1:4096`，不需要再填写服务器地址或密码。密码不保存在仓库中。未设置时，只监听本机的后端和开发前端使用内置测试密码。要换成自己的密码，在仓库根目录创建 `.env.local`：

```sh
OPENCODE_SERVER_PASSWORD=你的测试密码
VITE_OPENCODE_SERVER_HOST=127.0.0.1
VITE_OPENCODE_SERVER_PORT=4096
```

## 启动

已有服务运行时无需重复启动。临时工具和数据目录可能被系统清理。

在仓库根目录的后端终端中执行：

```sh
export PATH=/tmp/opencode-ex-tools/node_modules/.bin:$PATH
XDG_DATA_HOME=/tmp/opencode-ex-runtime/data \
XDG_CONFIG_HOME=/tmp/opencode-ex-runtime/config \
XDG_STATE_HOME=/tmp/opencode-ex-runtime/state \
XDG_CACHE_HOME=/tmp/opencode-ex-runtime/cache \
OPENCODE_TEST_HOME=/tmp/opencode-ex-runtime/home \
bun dev serve --hostname 127.0.0.1 --port 4096 \
  --cors http://127.0.0.1:4444 --cors http://localhost:4444
```

在第二个终端启动前端：

```sh
export PATH=/tmp/opencode-ex-tools/node_modules/.bin:$PATH
bun run dev:web -- --host 127.0.0.1 --port 4444 --strictPort
```

## 验证范围

- 已验证后端认证接口响应、Web 页面加载、密码登录，以及主界面 Add project、New session 和 Settings 入口。
- 浏览器未报告页面错误。
- 未配置模型密钥或发起模型调用，Agent 执行尚未验证。
- Vite 依赖预扫描报告共享 TSX 文件的 JSX 解析警告，随后跳过预打包；本次未阻止登录与主界面加载。
- 依赖安装更新了 `bun.lock`；未执行生产构建、完整测试或 Nix 依赖哈希刷新。
