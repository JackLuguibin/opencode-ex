# 本地测试环境

> 开发和部署只基于新架构（Auth 网关 + Postgres + Redis + 执行层）：`bun run dev:app` 会一次启动全部，端口和说明见 [README](README.md) 与 [packages/auth/README.md](packages/auth/README.md)。下面是早期单机后端的手动启动记录，仅供参考。

验证日期：2026-10-27。

- 前端：http://127.0.0.1:4444
- 后端：http://127.0.0.1:4096
- Bun 1.4.4：`/tmp/opencode-ex-tools/node_modules/.bin/bun`
- 测试数据与配置：`/tmp/opencode-ex-runtime`，与个人 OpenCode 数据隔离。

页面连接 `http://127.0.0.1:4096`。平时用 `bun run dev:web` 时前端在 `http://127.0.0.1:3000`；下面这条命令把前端开在 4444，只用于和已占用的 3000 错开。两种地址都会先显示工号和密码登录页，不再自动带上服务器密码。

网页账号和命令行密码分开。在 `.env.local` 写上管理员工号、管理员密码和服务器密码。文件已被 git 忽略：

```sh
OPENCODE_ADMIN_EMPLOYEE_ID=管理员工号
OPENCODE_ADMIN_PASSWORD=至少8位的管理员密码
OPENCODE_SERVER_PASSWORD=你的测试密码
VITE_OPENCODE_SERVER_HOST=127.0.0.1
VITE_OPENCODE_SERVER_PORT=4096
```

后端第一次启动且还没有管理员时，用工号和密码创建平台管理员。普通用户注册后停在等待页，直到管理员把该工号加入某个租户。管理员创建的第一个租户会接收数据库里还没有主人的项目，并记成这个管理员创建的。项目归属于创建时所在的租户，切换租户后只能看到当前租户下的项目。`OPENCODE_SERVER_PASSWORD` 只给命令行使用，能看到全部项目。

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

- 验收登录页：打开前端应看到工号和密码，而不是直接进入主界面。管理员登录后可以新建租户，并把工号加入租户。未加入租户的用户停在等待页。同一租户的两个用户互相看不到对方创建的项目。
- 浏览器未报告页面错误。
- 未配置模型密钥或发起模型调用，Agent 执行尚未验证。
- Vite 依赖预扫描报告共享 TSX 文件的 JSX 解析警告，随后跳过预打包；本次未阻止登录与主界面加载。
- 依赖安装更新了 `bun.lock`；未执行生产构建、完整测试或 Nix 依赖哈希刷新。
