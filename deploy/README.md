# 生产部署

架构：浏览器 → web（nginx，同源提供网页并代理 `/api`）→ Auth 网关 → 执行层 1..N；账号在 Postgres，执行层注册与组织放置在 Redis。说明见 [packages/auth/README.md](../packages/auth/README.md)。

## 首次部署

1. 准备一台装有 Docker 的 Linux 机器（执行层依赖 Linux 原生模块，镜像在机器上构建，不要挂载本机的 `node_modules`）。
2. 复制并修改密钥：

   ```bash
   cp deploy/.env.example deploy/.env
   ```

   | 变量 | 作用 |
   |---|---|
   | `POSTGRES_PASSWORD` | Postgres 密码 |
   | `OPENCODE_PASSWORD` | 执行层操作者密码，命令行和脚本用，能看到全部项目 |
   | `OPENCODE_GATEWAY_SECRET` | Auth 与执行层共享的签名密钥，两边必须一致 |
   | `ADMIN_EMPLOYEE_ID` / `ADMIN_PASSWORD` | 首个平台管理员，库里还没有管理员时才创建，密码至少 8 位 |
   | `WEB_PORT` | 对外端口，默认 8080 |

3. 启动：

   ```bash
   docker compose -f deploy/docker-compose.yml --env-file deploy/.env up -d --build
   ```

4. 打开 `http://<主机>:<WEB_PORT>`，用管理员登录，新建组织并加入成员。

## 对外访问与 HTTPS

compose 只提供 HTTP。生产要在 `web` 前面再放一层负责 TLS 的反向代理（或云负载均衡），转发到 `WEB_PORT`，并保持：

- 不缓冲、长超时（`/api/event` 是长连接 SSE，pty 是 WebSocket），可参考 `deploy/nginx.conf` 里 `/api/` 的设置。
- 允许上传至少 64MB（技能和插件包）。

只对外暴露 `web`。Postgres、Redis、Auth、执行层都不要映射到公网；`docker-compose.yml` 里除 `web` 外没有对外端口。

## 扩容

一个组织固定在一个执行层上，扩容就是增加执行层，让新组织落到新的层：

1. 复制 `runtime2` 服务，改名（如 `runtime3`）、改数据卷名和 `OPENCODE_ADVERTISE_URL`（容器名加端口）。
2. `docker compose ... up -d`。新层自动注册到 Redis，下一个新组织会放到持有组织最少的层上。

已有组织不会自动迁走，它的项目、会话和文件都在原来的执行层里。注册 id 默认就是 `OPENCODE_ADVERTISE_URL`，改这个地址会让该层原有的组织找不到它，需要保持不变。

## 数据在哪里，怎么备份

| 数据 | 位置 | 备份 |
|---|---|---|
| 账号、组织、成员、登录会话 | Postgres 卷 `postgres` | `pg_dump` |
| 项目、会话、消息、组织目录、全局包 | 各执行层的卷（`runtime1`、`runtime2`…，容器内 `/data`） | 停服后打包卷，或卷快照 |
| 组织到执行层的放置 | Redis 卷 `redis`（已开 AOF） | 随 Redis 卷备份；丢失后组织会被重新分配，**导致原数据找不到**，所以必须备份 |

执行层的数据没有跨层副本。某个执行层不可用时，固定在它上面的组织返回 503，其他组织不受影响；恢复该层后自动可用，不会被悄悄挪到别的层。

## 升级

```bash
git pull
docker compose -f deploy/docker-compose.yml --env-file deploy/.env up -d --build
```

执行层启动时会自动做数据库迁移，Postgres 的身份表也会自动迁移。一次升一个执行层可以减少中断：先 `up -d --build runtime1`，确认后再升其他服务。升级期间被重启的层上的组织会短暂返回 503。

## 从单机开发库迁移

先停掉执行层，再把账号迁入 Postgres（ID 不变，旧项目和会话保持关联）：

```bash
bun run --cwd packages/core migrate-identity -- \
  --from /path/to/opencode-local.db \
  --to postgres://opencode:<POSTGRES_PASSWORD>@<postgres 地址>/opencode --replace
```

然后让执行层使用同一份数据目录（挂载为该层的 `/data`）。`--replace` 会先清掉目标里已有的账号，包括从环境变量创建的管理员。

## 部署后验证

```bash
bun deploy/smoke.ts http://<主机>:<WEB_PORT> <ADMIN_EMPLOYEE_ID> <ADMIN_PASSWORD>
```

检查未登录被拒绝、管理员可登录、新建的两个组织各自能访问执行层且保持在同一层。它会留下两个 `smoke-*` 组织和用户，可在管理台删除用户。

## 当前的限制（内部使用时的取舍）

- 个人凭证存在各执行层本地，同一个用户属于落在不同层的多个组织时，个人凭证不共享。
- 全局技能、插件和共享 MCP 的写入会发给所有在线执行层；写入时某个层离线，之后不会自动补发，需要重新上传。
- 签名头只靠 60 秒有效期，没有防重放；Auth 与执行层之间的网络应当只在内网。
- Auth 本身无状态，可以多开，但 compose 里只有一个；Postgres 和 Redis 都是单实例，没有高可用。
- 用户在 Postgres 中删除后，各执行层本地留下的镜像行最多一分钟内自动清理；项目和会话保留，只是不再有所有者。组织目前不能删除（只能改名、移除成员）。
- 已验证（arm64 Linux 容器，真实构建并启动）：web 提供页面并回退到 `index.html`，未登录访问 `/api` 返回 401，管理员登录、建两个组织和成员均成功，两个组织分别固定在 `runtime1` 和 `runtime2`。尚未在浏览器里走一遍界面，也没有在 amd64 机器上构建过。
