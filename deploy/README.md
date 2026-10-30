# 生产部署

架构：浏览器 → Auth 网关（`opencode gateway`，同一端口提供网页和 `/api`）→ 执行层 1..N；账号在 Postgres，执行层注册与组织放置在 Redis。说明见 [packages/auth/README.md](../packages/auth/README.md)。

## 首次部署

1. 准备一台装有 Docker 的 Linux 机器（机器上不构建任何东西：容器首次启动时下载已构建好的程序包（GitHub release）并运行）。
2. 复制并修改密钥：

   ```bash
   cp deploy/.env.example deploy/.env
   ```

   | 变量 | 作用 |
   |---|---|
   | `POSTGRES_PASSWORD` | Postgres 密码 |
   | `OPENCODE_PASSWORD` | 执行层操作者密码，命令行和脚本用，能看到全部项目 |
   | `OPENCODE_GATEWAY_SECRET` | Auth 与执行层共享的签名密钥，两边必须一致 |
   | `OPENCODE_GATEWAY_SECRET_EXTRA` | 可选。执行层额外接受的签名密钥（逗号分隔），只在轮换密钥时用 |
   | `ADMIN_EMPLOYEE_ID` / `ADMIN_PASSWORD` | 首个平台管理员，库里还没有管理员时才创建，密码至少 8 位 |
   | `WEB_PORT` | 对外端口，默认 8080 |

3. 启动：

   ```bash
   docker compose -f deploy/docker-compose.yml --env-file deploy/.env up -d
   ```

4. 打开 `http://<主机>:<WEB_PORT>`，用管理员登录，新建组织并加入成员。

## 对外访问与 HTTPS

compose 只提供 HTTP。生产要在网关前面再放一层负责 TLS 的反向代理（或云负载均衡），转发到 `WEB_PORT`（单机）或网关的 4100 端口（分机），并保持：

- 不缓冲、长超时（`/api/event` 是长连接 SSE，pty 是 WebSocket），nginx 里对应 `proxy_buffering off`、`proxy_read_timeout 1h`、`Upgrade`/`Connection` 头。
- 允许上传至少 64MB（技能和插件包）。

只对外暴露网关。Postgres、Redis、Auth、执行层都不要映射到公网；`docker-compose.yml` 里除网关外没有对外端口。

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
docker compose -f deploy/docker-compose.yml --env-file deploy/.env up -d
```

执行层启动时会自动做数据库迁移，Postgres 的身份表也会自动迁移。一次升一个执行层可以减少中断：先把 `.env` 里的 `OPENCODE_VERSION` 改成新版本，再 `up -d runtime1`，确认后再升其他服务。升级期间被重启的层上的组织会短暂返回 503。

停止一个执行层时（`docker stop`、升级重启）它先在 Redis 里标记为排空（不再接收新组织），拒绝新建会话和新提示（返回 503），等正在运行的会话结束，最长 `OPENCODE_DRAIN_TIMEOUT_MS`（默认 30000），然后注销并关闭。超时仍在运行的会话被中断，下次启动自动续跑。容器的 `stop_grace_period` 必须大于排空时间加 10 秒，compose 里已设为 45s。

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

## 轮换网关签名密钥

分三步，每一步都不会让任何一边拒绝另一边：

1. 执行层：保持 `OPENCODE_GATEWAY_SECRET` 为旧密钥，把新密钥放进 `OPENCODE_GATEWAY_SECRET_EXTRA`，重启各执行层（可一次一个，参考"升级"）。
2. 网关：把 `OPENCODE_GATEWAY_SECRET` 改成新密钥，重启 auth。
3. 执行层：`OPENCODE_GATEWAY_SECRET` 改成新密钥，清空 `OPENCODE_GATEWAY_SECRET_EXTRA`，再重启。

第 2 步之后网关发出的头只用新密钥，此时旧密钥已不再被使用，第 3 步才能安全移除。

## 事件流断线续传

`GET /api/event` 的每个事件帧带 `id:`（即事件自己的 id）。浏览器在断线重连时带上 `Last-Event-ID`，执行层就会把这之后的事件补发一遍，补发和实时事件走同一套权限过滤（按组织、项目和会话可见性），不会多给也不会重复。`server.connected` 里的 `resumed` 说明结果：`true` 表示补齐了；`false` 表示补不上（该 id 已滚出缓冲，或这个执行层重启过），调用方应当像以前一样整体刷新。重新开始（没带 `Last-Event-ID`，或补不上）的连接，`server.connected` 还带 `cursor`，即此刻最新事件的 id，客户端记下它，这样即使在收到任何事件之前断线，也能从这里续传。

**目前网页前端并没有因此省掉重新加载**：它的各个查询在连接状态恢复时仍会各自重新拉取（实测一次续传成功的重连，请求数和首次加载相当），所以续传补发的事件对网页来说是多余但无害的。这个能力现在服务于直接使用事件流的客户端；让网页真正受益需要另外处理连接状态的抖动。

每个执行层在内存里保留最近 4096 条事件（同时不超过 16MB），全体用户共用这一份，所以内存不随用户数增长。重启执行层一定会让所有客户端整体刷新一次。重连的等待时间现在是 1 秒起指数增长到 10 秒并带随机抖动，避免一次升级后所有客户端同时回连。

## 登录限流、审计日志与在线状态

- **登录限流**：网关按工号统计登录失败（Redis 键 `login-failures:<工号>`），连续 10 次失败后该工号 15 分钟内的登录返回 429，登录成功会清零。这是按工号而不是按来源地址限制，所以别人也能故意输错把某个工号锁住 15 分钟；内部使用时认为可以接受。没有 Redis 的单层部署不启用。
- **审计日志**：创建和删除账号、授予或收回平台管理员、改姓名、重置密码、创建、重命名和删除组织、成员的加入、角色变更和移除、入组申请的批准和拒绝，以及成员创建和删除项目、创建和删除会话（项目在被首次使用时记为创建，组织的默认目录和共享空间不记），都会写入共享库的 `identity_audit`（只增不改，不带外键，账号或组织被删后记录仍在）。平台管理员用 `GET /api/auth/audit?limit=100` 查看，最多 500 条，最新的在前。管理后台的「操作记录」页可以查看和搜索。
- **会话在线状态**：谁在看、谁在操作一个会话，存在 Redis 的 `presence:<会话>`（有序集合，45 秒不续约即过期），所有执行层看到同一份；Redis 不可用或没有 Redis 时退回各进程自己的内存。

## 当前的限制（内部使用时的取舍）

- 个人凭证存在各执行层本地，同一个用户属于落在不同层的多个组织时，个人凭证不共享。
- 全局技能、插件和共享 MCP 的写入会发给所有在线执行层。网关记录哪些层接受了这次写入（Redis 的 `global-revision`、`global-applied`）；离线或拒绝了写入的层回来后，在 5 秒一次的心跳里发现自己落后，就用操作者密码从一个已是最新的层复制（`GET /internal/global-state`，仅内网，只认操作者密码），不需要重新上传。所有层密码必须一致；没有任何层是最新时只记录警告。复制的范围只有这三类全局状态，各组织自己的启停开关和 `PATCH /api/experimental/config` 等平台配置不在其中。Redis 里的计数需要持久化（compose 已开 AOF），丢失后落后的层无法发现自己落后。
- 签名头有效期 60 秒，每个头带一次性 id，执行层在内存里记住最近见过的 id，同一个头第二次出现返回 403（`gateway_replay`）。这个记录只在单个执行层进程内，重启后清空，所以不是严格防重放；Auth 与执行层之间的网络仍应当只在内网。
- Auth 本身无状态，可以多开，但 compose 里只有一个；Postgres 和 Redis 都是单实例，没有高可用。
- 用户在 Postgres 中删除后，各执行层本地留下的镜像行最多一分钟内自动清理；项目和会话保留，只是不再有所有者。平台管理员可在管理台删除组织：成员账号保留，组织的项目、会话和文件在它所在的执行层上一并删除，不可恢复；该组织所在的执行层离线时无法删除（返回 503）。
- 已验证（arm64 Linux 容器，真实构建并启动）：web 提供页面并回退到 `index.html`，未登录访问 `/api` 返回 401，管理员登录、建两个组织和成员均成功，两个组织分别固定在 `runtime1` 和 `runtime2`。尚未在浏览器里走一遍界面，也没有在 amd64 机器上构建过。

## 分机部署

Postgres/Redis、执行层、网关可以放在不同机器上，各自一个 compose 文件和一个 env 文件，连接全部用 URL 配置：

| 机器 | 命令 | env（由 `deploy/env/*.env.example` 复制） |
|---|---|---|
| infra（Postgres + Redis） | `docker compose -f deploy/infra.yml --env-file deploy/env/infra.env up -d` | 两个密码、端口 |
| 执行层（每台一份） | `docker compose -f deploy/runtime.yml --env-file deploy/env/runtime.env up -d` | Postgres/Redis URL、签名密钥、`OPENCODE_ADVERTISE_URL`（网关访问本机的地址） |
| 网关 | `docker compose -f deploy/gateway.yml --env-file deploy/env/gateway.env up -d` | Redis URL、签名密钥 |

- 签名密钥在网关和所有执行层上必须一致；Postgres/Redis URL 在所有执行层上相同，网关只需要 Redis。
- Redis 对外提供服务必须设密码（URL 写成 `redis://:密码@主机:端口`），端口只对执行层和网关所在机器开放。
- 所有 compose 都不构建镜像。容器用现成的 `buildpack-deps`（带 git、curl）镜像，启动时按 `OPENCODE_VERSION` 从 GitHub release 下载 `opencode-ex-<版本>-linux-x64.tar.gz`（包含 `bin/opencode` 一个二进制（`opencode serve` 是执行层，`opencode gateway` 是网关，共用同一个运行时），网关同时提供二进制内置的网页），解压到卷里；再次启动或同版本重启不会重复下载，改了版本才会重新下载。执行层首次启动会用 apt 装 ripgrep。
- 仓库是私有时，release 地址需要令牌：设 `OPENCODE_PACKAGE_TOKEN`，或把包放到内部文件服务器后用 `OPENCODE_PACKAGE_URL` 指过去。
- 发布程序包在你自己的机器上：`gh auth login` 一次，然后 `sh script/release.sh v1.0.0`（默认构建 linux-x64、linux-arm64、darwin-arm64、darwin-x64，`TARGETS=linux-x64` 只构建一种；`PUBLISH=0` 只打包不发布）。
- 单机部署仍用 `deploy/docker-compose.yml`，网关在 `WEB_PORT`（默认 8080）上同时提供网页和 API。

多个执行层：分机部署时每台机器各跑一份 `runtime.yml`，`OPENCODE_ADVERTISE_URL` 各填自己的地址，其余配置相同；同一台机器上再起一个要用不同的 compose 项目名（`-p`）、端口映射和数据卷。本地开发在 `.env.local` 里写 `OPENCODE_RUNTIME_URLS=http://127.0.0.1:4097,http://127.0.0.1:4098`，`bun run dev:runtime` 每个地址起一个。

## 程序包与发布

一个程序包就是一个二进制 `bin/opencode`，两个角色共用它：

| 角色 | 命令 | 作用 |
|---|---|---|
| 执行层 | `opencode serve --hostname 0.0.0.0 --port 4096` | 运行会话、项目和文件，连 Postgres 和 Redis |
| 网关 | `opencode gateway` | 登录、转发 `/api` 到执行层，同一端口还提供二进制内置的网页；只连 Redis |

发布（在你自己的机器上构建并上传到 GitHub release）：

```bash
gh auth login                                   # 只需一次
sh script/release.sh v1.0.0                     # 构建 linux-x64 linux-arm64 darwin-arm64 darwin-x64 并发布
TARGETS=linux-x64 sh script/release.sh v1.0.0   # 只构建一种
PUBLISH=0 sh script/release.sh v1.0.0           # 只打包不发布，结果在 release/
```

包名是 `opencode-ex-<版本>-<平台>.tar.gz`。每次构建约几分钟，单个包约 110MB。

## 不用 Docker 直接运行

下载解压后直接运行，配置放在一个 env 文件里，用 `--env-file` 传入（也可以设 `OPENCODE_ENV_FILE`）：

```bash
tar -xzf opencode-ex-v1.0.0-linux-x64.tar.gz
./opencode-ex-v1.0.0-linux-x64/bin/opencode serve   --env-file /etc/opencode/runtime.env
./opencode-ex-v1.0.0-linux-x64/bin/opencode gateway --env-file /etc/opencode/gateway.env
```

- 二进制**不会**自动读工作目录里的 `.env`，必须显式传文件。
- 进程环境里已有的变量优先于文件，可以用来临时覆盖某一项。
- 文件读不到会直接报错退出。
- 执行层需要机器上有 `git` 和 `ripgrep`。

### 配置项

地址都写成一个 URL，不拆主机和端口。

| 变量 | 用于 | 说明 |
|---|---|---|
| `OPENCODE_IDENTITY_POSTGRES_URL` | 执行层 | 共享 Postgres，存账号、组织、成员和登录会话 |
| `OPENCODE_REGISTRY_URL` | 执行层、网关 | Redis，执行层在这里登记，网关从这里找执行层 |
| `OPENCODE_ADVERTISE_URL` | 执行层 | 网关访问这台执行层的地址，也是它在 Redis 里的 id，已有组织落在这台之后不要改 |
| `OPENCODE_AUTH_URL` | 网关 | 网关监听的地址，默认 `http://127.0.0.1:4100`，对外服务用 `http://0.0.0.0:4100` |
| `OPENCODE_GATEWAY_SECRET` | 网关、执行层 | 签名密钥，两边必须一致 |
| `OPENCODE_GATEWAY_SECRET_EXTRA` | 执行层 | 可选，轮换密钥时额外接受的旧密钥（逗号分隔） |
| `OPENCODE_PASSWORD` | 执行层 | 操作者密码 |
| `OPENCODE_ADMIN_EMPLOYEE_ID` / `OPENCODE_ADMIN_PASSWORD` | 执行层 | 首个平台管理员，库里还没有管理员时才创建 |
| `OPENCODE_UPSTREAM_URL` | 网关 | 不用 Redis、只有一台执行层时，直接指定它的地址 |

示例 env 文件在 `deploy/env/*.env.example`（容器部署用）和仓库根目录 `.env.example`（本地开发用）。

### 用 systemd 管理

```ini
# /etc/systemd/system/opencode-gateway.service
[Unit]
Description=opencode gateway
After=network-online.target

[Service]
ExecStart=/opt/opencode/bin/opencode gateway --env-file /etc/opencode/gateway.env
Restart=always
User=opencode

[Install]
WantedBy=multi-user.target
```

执行层同理，把命令换成 `opencode serve --hostname 0.0.0.0 --port 4096 --env-file /etc/opencode/runtime.env`，并把 `Environment=XDG_DATA_HOME=/var/lib/opencode` 加到 `[Service]`，数据才会放在固定位置。

### 容器里怎么传

compose 把 env 文件里的变量逐个传进容器，所以容器部署不需要 `--env-file`。想让容器里的二进制直接读文件，可以把文件挂载到容器内，再在 `command` 末尾加 `--env-file /path`。
