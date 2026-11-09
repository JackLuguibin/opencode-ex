# 生产部署

架构：浏览器 → Auth 网关（`opencode gateway`，同一端口提供网页和 `/api`）→ 执行层 1..N；账号和组织放置在 Postgres，执行层注册（心跳、租约）在 Redis。说明见 [packages/auth/README.md](../packages/auth/README.md)。

## 首次部署

1. 准备一台装有 Docker 的 Linux 机器（机器上不构建任何东西：容器首次启动时下载已构建好的程序包（GitHub release）并运行）。
2. 复制并修改密钥：

   ```bash
   cp deploy/.env.prod.example deploy/.env.prod
   ```

   | 变量 | 作用 |
   |---|---|
   | `POSTGRES_PASSWORD` | Postgres 密码 |
   | `OPENCODE_PASSWORD` | 执行层操作者密码，命令行和脚本用，能看到全部项目 |
   | `OPENCODE_GATEWAY_SECRET` | Auth 与执行层共享的签名密钥，两边必须一致 |
   | `OPENCODE_GATEWAY_SECRET_EXTRA` | 可选。执行层额外接受的签名密钥（逗号分隔），只在轮换密钥时用 |
   | `OPENCODE_ADMIN_EMPLOYEE_ID` / `OPENCODE_ADMIN_PASSWORD` | 首个平台管理员，库里还没有管理员时才创建，密码至少 8 位 |
   | `WEB_PORT` | 对外端口，默认 8080 |

3. 启动：

   ```bash
   docker compose -f deploy/docker-compose.yml --env-file deploy/.env.prod up -d
   ```

4. 打开 `http://<主机>:<WEB_PORT>`，用管理员登录，新建组织并加入成员。

## 对外访问与 HTTPS

用域名访问时必须在 `.env.prod` 里配 `OPENCODE_PUBLIC_URL`（浏览器地址栏里的完整地址，如 `https://opencode.example.com`，带端口时要写端口，末尾不加斜杠）。执行层只接受来自这个地址的终端和 MCP 连接请求，没配时这些功能会返回 403；执行层启动命令已经带上了 `--cors`，改完后 `up -d` 重建执行层即可。

### 用自带的 nginx 终止 TLS

1. 把证书放进 `deploy/certs/`，文件名固定为 `fullchain.pem`、`privkey.pem`（换目录用 `OPENCODE_TLS_DIR`）。
2. `.env.prod` 里设置 `OPENCODE_PUBLIC_URL=https://你的域名`、`WEB_BIND=127.0.0.1`（让网关只能经 nginx 访问）。
3. 带上 `--profile https` 启动：

   ```bash
   docker compose -f deploy/docker-compose.yml --env-file deploy/.env.prod --profile https up -d
   ```

   分机部署在网关那台机器上同样用 `deploy/gateway.yml`。

nginx 配置在 `deploy/nginx.conf.template`：80 跳转到 443，TLS 1.2/1.3，请求体上限 64MB，关闭缓冲、读写超时 1 小时（`/api/event` 是长连接 SSE，终端是 WebSocket，漏掉超时设置终端空闲一分钟就会断），并每 10 秒重新解析网关地址，网关容器重建后不会连到旧地址。端口用 `HTTP_PORT`、`HTTPS_PORT` 改。证书续期后 `docker compose ... exec https nginx -s reload`。

### 用自己的反向代理或云负载均衡

转发到 `WEB_PORT`（单机）或网关的 4100 端口（分机），并保持：

- 不缓冲、长超时（`proxy_buffering off`、`proxy_read_timeout 1h`，加 `Upgrade`/`Connection` 头）。
- 请求体至少 64MB（技能和插件包）。
- `Host` 头用 `$http_host`，保留原始端口。

只对外暴露网关或这一层代理。Postgres、Redis、Auth、执行层都不要映射到公网；`docker-compose.yml` 里除网关（和可选的 nginx）外没有对外端口。

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
| 组织到执行层的放置 | Postgres 表 `organization_placement` | 随 `pg_dump` 备份；丢失后组织会被重新分配，**导致原数据找不到** |
| 执行层心跳、登录限流、在线状态、全局包修订号 | Redis 卷 `redis` | 丢了会自动恢复(全局包修订号丢了落后的层发现不了落后) |

执行层的数据没有跨层副本。某个执行层不可用时，固定在它上面的组织返回 503，其他组织不受影响；恢复该层后自动可用，不会被悄悄挪到别的层。

## 升级

从把放置记录存在 Redis 的旧版本升级：网关现在必须能连到 Postgres（`OPENCODE_IDENTITY_POSTGRES_URL`，与执行层同一个），否则拒绝启动。网关第一次启动会把 Redis 里的 `organization-runtime` 复制进 Postgres 的 `organization_placement`，并把旧哈希改名为 `organization-runtime:imported`（留作备份，不再读取），已有组织不会换层。

```bash
git pull
docker compose -f deploy/docker-compose.yml --env-file deploy/.env.prod up -d
```

执行层启动时会自动做数据库迁移，Postgres 的身份表也会自动迁移。一次升一个执行层可以减少中断：先把 `.env.prod` 里的 `OPENCODE_VERSION` 改成新版本，再 `up -d runtime1`，确认后再升其他服务。升级期间被重启的层上的组织会短暂返回 503。

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
bun deploy/smoke.ts http://<主机>:<WEB_PORT> <OPENCODE_ADMIN_EMPLOYEE_ID> <OPENCODE_ADMIN_PASSWORD>
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

## 默认组织与游客模式

- **默认组织**：设置 `OPENCODE_DEFAULT_ORGANIZATION`（组织 id 或名称，找不到就按名称创建）后，登录或注册时不属于任何组织的账号会自动加入它，不再停在「等待加入组织」。不配时默认使用 `Other`。被移出所有组织的账号再登录也会被加回这个组织；要把人挡在外面，得删除账号。
- **游客模式**：设置 `OPENCODE_GUEST_ENABLED=true`（同时配好上面的默认组织）后，打开网页不再显示登录页，而是直接创建一个匿名账号进入（工号形如 `guest_…`，没有可用密码，只有这个浏览器里的登录令牌能回到它），并加入默认组织。游客是默认组织的普通成员，能看到这个组织里共享的会话和项目；清掉浏览器数据后再进来就是一个新账号。退出登录后当前标签页回到登录页（可以再点「以游客身份继续」，或用真实账号登录），新开的标签页仍会自动以游客进入。游客进入的就是 `OPENCODE_DEFAULT_ORGANIZATION`（不配为 `Other`）。

## ZTE UAC 单点登录

设置 `OPENCODE_UAC_ENABLED=true` 和四个 `OPENCODE_UAC_*` 变量后，登录页会先静默地问企业凭证服务这个浏览器有没有已登录的 UAC 会话：有就直接登录（账号第一次出现时自动创建，没有可用密码），没有就退回登录页，多出一个「Sign in with UAC」按钮跳转企业门户。UAC 账号如果没有组织，和普通登录、游客一样加入 `OPENCODE_DEFAULT_ORGANIZATION`。刚退出的标签页不会再被静默登录。

企业凭证服务要允许网页跨域携带 Cookie，网页本身也要挂在 UAC 的 Cookie 域下（例如 `*.zte.com.cn`）；变量含义和这项要求的细节见 `deploy/.env.prod.example`。没有配默认组织时，UAC 账号仍然可以登录，只是会停在「等待加入组织」。

## 会话数据同步到 Postgres（用于分析和改进）

每个执行层定时把本层的会话和消息复制到共享 Postgres，方便跨执行层、跨组织分析。只有设置了 `OPENCODE_IDENTITY_POSTGRES_URL` 才会启用，单机（TUI）模式不同步。

- **同步什么**：会话（标题、目录、智能体、模型、花费、token、创建人、当前持有人、可见范围、时间）写入 `session_sync_session`；每条消息的完整内容（用户输入、模型回复、工具调用和结果）写入 `session_sync_message`（`data` 是 jsonb，主键 `(session_id, seq)`）。两张表都带 `organization_id` 和 `runtime_id`，没有外键，会话被删或组织被删后副本不会自动消失（删除组织时副本一并删除）。
- **怎么同步**：每个执行层在本地 SQLite 的 `session_sync_cursor` 里记着已发送到哪个 `(time_updated, id)`，每轮只发之后改动过的行（会话、消息和项目三类；项目表 `session_sync_project` 以执行层加项目 ID 为键，消息带 `project_id`），写入是 upsert，重复发送无害。更新中的消息（回复还在生成）每次变化都会重新发送并覆盖旧副本。默认每 60 秒一轮，`OPENCODE_SESSION_SYNC_INTERVAL`（秒）调整，`0` 关闭本层的同步。积压超过一轮的上限（约 5000 行）时，下一轮 1 秒后就接着发，追平后才回到默认间隔。Postgres 不可用只记警告，不影响会话，恢复后自动补发。
- **组织开关**：管理后台组织的「成员可见的设置页」里有「同步会话用于分析」，默认开。关闭后该组织**之后**产生的变化不再同步；重新打开也**不会**补发关闭期间的内容。已经同步的数据保留，要清除需手动删除对应 `organization_id` 的行。
- **脱敏是尽力而为**：写入前会把名字像凭证的字段（`apiKey`、`secret`、`password`、`authorization`、`access_token` 等；`tokens` 这类用量计数不受影响）的值，以及形如 `sk-…`、`Bearer …`、`ghp_…`、`AKIA…`、私钥块的文本替换为 `[redacted]`。工具输出里的文件内容、命令输出可能含有这里认不出的密钥，会原样同步，所以这份库要按"含源码和敏感内容"的级别管理访问权限。
- **消息发送人**：`session_sync_message.user_id` 是提交这条用户消息的人（由执行层在收到提示时记录，来自网关签名的操作者；命令行等没有登录用户的入口为空）；助手消息取它前面最近一条用户消息的发送人。升级之前产生的旧消息没有发送人，不回填，按用户统计时会落在“未知”。
- **用量统计**：管理后台有「用量」页，数据来自这些同步下来的消息，不需要另外建表。组织管理员在组织的「用量」标签页看本组织，平台管理员在「用量」视图看所有组织，普通成员从账号菜单的「我的用量」只看自己。可以按天、用户、模型、项目、会话汇总，也能搜会话标题并展开看已脱敏的消息。统计的是消息里记录的模型调用（助手消息和压缩消息的 `cost`、`tokens`，同步时提取成 `session_sync_message` 的列）；生成标题等附带调用只计入会话行的合计，所以会话合计可能略高于逐条之和。也可以直接用 SQL 汇总，例如：`SELECT organization_id, sum(cost) FROM session_sync_message GROUP BY 1`。额度限制还没做，现在只有统计。

### 用户级全局密钥

用户在「连接提供商」时可以选「我的所有组织」，这把 API Key 在他所属的每个组织里都能用，不用在每个组织、每个执行层重复配置。

- **存哪里**：共享 Postgres 的 `identity_user_credential`（每个用户、每个提供商一行）。值用 AES-256-GCM 加密后存，主密钥是 `OPENCODE_SECRET_KEY`（32 字节 base64，`openssl rand -base64 32`），每个执行层必须配同一个。没配主密钥时功能关闭：界面不出现这个选项，接口返回 400，也不会明文落库。
- **谁能看**：只有本人。界面和接口只返回密钥的最后 4 位；管理员也读不到别人的密钥；审计日志只记「设置/删除了哪个提供商的密钥」，不记密钥。用户被删除时，他的密钥随之删除。
- **优先级**：同一个提供商有多把密钥时，用户在当前组织里自己连的 > 用户的全局密钥 > 组织共享的密钥 > 环境变量。
- **范围**：只支持 API Key。OAuth 登录需要刷新后回写，不做；自定义提供商（个人提供商）属于某个组织，也不支持。
- **生效时间**：执行层把用户的密钥缓存 30 秒，在别的执行层上改了密钥最多 30 秒后生效；在本层改的立即生效。
- **换主密钥**：把新密钥写进 `OPENCODE_SECRET_KEY`，旧的写进 `OPENCODE_SECRET_KEY_PREVIOUS`（可写多个，逗号分隔），重启所有执行层。旧密钥封的值仍能读，用户重新保存时换成新密钥。旧密钥也丢了的值读不出来，会被跳过（用户退回到组织的密钥，重新保存即可）。
- **威胁模型**：只拿到 Postgres（备份、只读账号、SQL 注入）看到的是密文；要还原明文还需要主密钥。所以主密钥不要和数据库、数据库备份放在一起。能登录执行层机器的人能读到主密钥和环境变量，这一点没有改变。

## 当前的限制（内部使用时的取舍）

- 个人凭证（在某个组织里自己连的）、个人提供商和个人的模型偏好按组织隔离（主键带组织），存在组织所在的执行层本地；要让一把 API Key 在所有组织通用，用上面的全局密钥。
- 全局技能、插件和共享 MCP 的写入会发给所有在线执行层。网关记录哪些层接受了这次写入（Redis 的 `global-revision`、`global-applied`）；离线或拒绝了写入的层回来后，在 5 秒一次的心跳里发现自己落后，就用操作者密码从一个已是最新的层复制（`GET /internal/global-state`，仅内网，只认操作者密码），不需要重新上传。所有层密码必须一致；没有任何层是最新时只记录警告。复制的范围只有这三类全局状态，各组织自己的启停开关和 `PATCH /api/experimental/config` 等平台配置不在其中。Redis 里的计数需要持久化（compose 已开 AOF），丢失后落后的层无法发现自己落后。
- 签名头有效期 60 秒，每个头带一次性 id，执行层在内存里记住最近见过的 id，同一个头第二次出现返回 403（`gateway_replay`）。这个记录只在单个执行层进程内，重启后清空，所以不是严格防重放；Auth 与执行层之间的网络仍应当只在内网。
- Auth 本身无状态，可以多开，但 compose 里只有一个；Postgres 和 Redis 都是单实例，没有高可用。
- 用户在 Postgres 中删除后，各执行层本地留下的镜像行最多一分钟内自动清理；项目和会话保留，只是不再有所有者。平台管理员可在管理台删除组织：成员账号保留，组织的项目、会话和文件在它所在的执行层上一并删除，不可恢复；该组织所在的执行层离线时无法删除（返回 503）。
- 游客账号不清理：每次以游客进入都会在 Postgres 里留下一个 `guest_…` 账号（没有可用密码，只有浏览器里的令牌能回到它）。目前没有过期和清理机制，也没有限流；对外开放并且长期运行时，需要自己按需删除没人用的游客账号及其登录会话。
- 已验证（arm64 Linux 容器，真实构建并启动）：web 提供页面并回退到 `index.html`，未登录访问 `/api` 返回 401，管理员登录、建两个组织和成员均成功，两个组织分别固定在 `runtime1` 和 `runtime2`。尚未在浏览器里走一遍界面，也没有在 amd64 机器上构建过。

## 分机部署

Postgres/Redis、执行层、网关可以放在不同机器上，各自一个 compose 文件，共用同一个 env 文件，连接全部用 URL 配置：

| 机器 | 命令 | env（复制 `deploy/.env.prod.example` 为 `deploy/.env.prod`，各机器共用同一个文件，只有 `OPENCODE_ADVERTISE_URL` 各填自己的） |
|---|---|---|
| infra（Postgres + Redis） | `docker compose -f deploy/infra.yml --env-file deploy/.env.prod up -d` | 两个密码、端口 |
| 执行层（每台一份） | `docker compose -f deploy/runtime.yml --env-file deploy/.env.prod up -d` | Postgres/Redis URL、签名密钥、`OPENCODE_ADVERTISE_URL`（网关访问本机的地址） |
| 网关 | `docker compose -f deploy/gateway.yml --env-file deploy/.env.prod up -d` | Redis URL、Postgres URL、签名密钥 |

- 签名密钥在网关和所有执行层上必须一致；Postgres/Redis URL 在所有执行层上相同，网关只需要 Redis。
- Redis 对外提供服务必须设密码（URL 写成 `redis://:密码@主机:端口`），端口只对执行层和网关所在机器开放。
- 所有 compose 都不构建镜像。容器用现成的 `buildpack-deps`（带 git、curl）镜像，启动时按 `OPENCODE_VERSION` 从 GitHub release 下载 `opencode-ex-<版本>-linux-x64.tar.gz`（包含 `bin/opencode` 一个二进制（`opencode serve` 是执行层，`opencode gateway` 是网关，共用同一个运行时），网关同时提供二进制内置的网页），解压到卷里；再次启动或同版本重启不会重复下载，改了版本才会重新下载。执行层首次启动会用 apt 装 ripgrep。
- 仓库是私有时，release 地址需要令牌：设 `OPENCODE_PACKAGE_TOKEN`，或把包放到内部文件服务器后用 `OPENCODE_PACKAGE_URL` 指过去。
- 发布程序包在你自己的机器上：`gh auth login` 一次，然后 `sh script/release.sh v1.0.0`（默认构建 linux-x64、linux-arm64、darwin-arm64、darwin-x64，`TARGETS=linux-x64` 只构建一种；`PUBLISH=0` 只打包不发布）。
- 单机部署仍用 `deploy/docker-compose.yml`，网关在 `WEB_PORT`（默认 8080）上同时提供网页和 API。

多个执行层：分机部署时每台机器各跑一份 `runtime.yml`，`OPENCODE_ADVERTISE_URL` 各填自己的地址，其余配置相同；同一台机器上再起一个要用不同的 compose 项目名（`-p`）、端口映射和数据卷。本地开发在 `deploy/.env.dev` 里写 `OPENCODE_RUNTIME_URLS=http://127.0.0.1:4097,http://127.0.0.1:4098`，`bun run dev:runtime` 每个地址起一个。

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
./opencode-ex-v1.0.0-linux-x64/bin/opencode serve   --env-file /etc/opencode/opencode.env
./opencode-ex-v1.0.0-linux-x64/bin/opencode gateway --env-file /etc/opencode/opencode.env
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
| `OPENCODE_SECRET_KEY` | 执行层 | 封存用户全局密钥的主密钥，32 字节 base64；不配则该功能关闭。轮换时旧的放 `OPENCODE_SECRET_KEY_PREVIOUS` |
| `OPENCODE_REGISTRY_URL` | 执行层、网关 | Redis，执行层在这里登记，网关从这里找执行层 |
| `OPENCODE_ADVERTISE_URL` | 执行层 | 网关访问这台执行层的地址，也是它在 Redis 里的 id，已有组织落在这台之后不要改 |
| `OPENCODE_AUTH_URL` | 网关 | 网关监听的地址，默认 `http://127.0.0.1:4100`，对外服务用 `http://0.0.0.0:4100` |
| `OPENCODE_GATEWAY_SECRET` | 网关、执行层 | 签名密钥，两边必须一致 |
| `OPENCODE_GATEWAY_SECRET_EXTRA` | 执行层 | 可选，轮换密钥时额外接受的旧密钥（逗号分隔） |
| `OPENCODE_PASSWORD` | 执行层 | 操作者密码 |
| `OPENCODE_ADMIN_EMPLOYEE_ID` / `OPENCODE_ADMIN_PASSWORD` | 执行层 | 首个平台管理员，库里还没有管理员时才创建 |
| `OPENCODE_DEFAULT_ORGANIZATION` | 执行层 | 没有组织的账号登录时自动加入的组织（id 或名称，按名称找不到就创建）。不配则默认加入 `Other` |
| `OPENCODE_ORGANIZATIONS_ROOT` | 执行层 | 所有组织目录的根（每个组织是其下的 `<组织ID>/`，含默认目录和公共空间）。不配则为数据目录下的 `organizations`。容器部署时需把该路径挂载出来 |
| `OPENCODE_SANDBOX_READ` | 执行层 | 组织内的 shell、终端和 stdio MCP 在沙箱里只看得到系统目录和本组织目录。python、node 等装在 home 或数据目录下的程序（含 venv 指向的解释器）需要把所在目录列在这里，冒号分隔，沙箱内只读可见。更省事的做法是装到 `/usr/local` |
| `OPENCODE_SANDBOX_NETWORK` | 执行层 | 设为 `off` 时（仅 Linux）组织内的 shell、终端和 stdio MCP 没有网络：连本机回环上的执行层、Postgres、Redis 也不通，同时 npm、pip、curl 等也不能联网。默认不设，因为多数组织需要装依赖；Postgres 和 Redis 必须设密码 |
| `OPENCODE_GUEST_ENABLED` | 执行层 | 开启游客模式：打开网页即以匿名账号进入上面的默认组织，不显示登录页。需要同时配 `OPENCODE_DEFAULT_ORGANIZATION` |
| `OPENCODE_UAC_ENABLED` / `OPENCODE_UAC_*` | 执行层 | ZTE UAC 企业账号单点登录；开关和四个参数都配置才生效，账号没有组织时加入 `OPENCODE_DEFAULT_ORGANIZATION` |
| `OPENCODE_WEB_TITLE` | 网关（也对直接访问执行层生效） | 产品名，默认 `OpenCode`。改标签页标题、会话页标题（“会话名 · 产品名”）、安装为应用后的名称，以及界面文案里的 “OpenCode”；“OpenCode Go/Console/Free/Zen/V2” 这类上游产品名和错误上报那句保持原样 |
| `OPENCODE_UPSTREAM_URL` | 网关 | 不用 Redis、只有一台执行层时，直接指定它的地址 |

环境用 env 文件区分，compose 文件只有一套：`deploy/.env.dev.example`（开发）、`deploy/.env.test.example`（测试）、`deploy/.env.prod.example`（生产），复制去掉 `.example` 即用，真实文件已被 git 忽略。`infra.yml` 在三个环境里是同一个文件，靠 env 里的 `COMPOSE_PROJECT_NAME`（容器和数据卷隔离）、`BIND_HOST`、端口和密码区分。

- 开发：`bun run dev:infra` 缺 `.env.dev` 时自动从示例复制，用 `127.0.0.1:5436` 的 Postgres 和 `127.0.0.1:6380` 的 Redis（无密码）；所有开发脚本（`dev`、`dev:runtime`、`dev:gateway`、`dev:web`）都只读 `deploy/.env.dev`，个人的密码也写在这里（文件已被 git 忽略）。
- 测试：`bun run test:stack`、`bun run test:smoke` 复用开发的 Postgres 和 Redis（不另起一套），用 `.env.test` 里的独立数据库 `opencode_test`、`opencode_smoke` 和 Redis 的 15、14 号库，不碰 `dev:app` 的数据。
- 生产：`.env.prod`，Redis 必须设密码。

### 用 systemd 管理

```ini
# /etc/systemd/system/opencode-gateway.service
[Unit]
Description=opencode gateway
After=network-online.target

[Service]
ExecStart=/opt/opencode/bin/opencode gateway --env-file /etc/opencode/opencode.env
Restart=always
User=opencode

[Install]
WantedBy=multi-user.target
```

执行层同理，把命令换成 `opencode serve --hostname 0.0.0.0 --port 4096 --env-file /etc/opencode/opencode.env`，并把 `Environment=XDG_DATA_HOME=/var/lib/opencode` 加到 `[Service]`，数据才会放在固定位置。

### 容器里怎么传

compose 把 env 文件里的变量逐个传进容器，所以容器部署不需要 `--env-file`。想让容器里的二进制直接读文件，可以把文件挂载到容器内，再在 `command` 末尾加 `--env-file /path`。

## 常见问题排查

### 网页终端打不开：`POST /api/pty` 返回 500，日志报 `TypeError: undefined is not an object (evaluating 'D.symbols')`

**根因**：网页终端走的是 bun-pty 原生实现，它运行时用 `Bun.dlopen` 加载 `librust_pty.so`。打包成单二进制后，bun-pty 默认从二进制内嵌的 `$bunfs/root/librust_pty-*.so` 路径加载，而 Bun **不支持从 `$bunfs` 内嵌文件系统 dlopen 共享库**，`dlopen` 失败后 `lib` 为 `undefined`，于是访问 `lib.symbols` 就抛上面的错误。服务端日志里能看到连续的 `http.method=POST http.url=/api/pty http.status=500`。

**修复**：把 bun-pty 对应平台的原生库放到真实文件路径，并用 `BUN_PTY_LIB` 指过去（bun-pty 优先读这个变量）：

1. 取到与部署平台匹配的 `librust_pty.so`。glibc x86-64 的版本可从 bun-pty 包（`node_modules/bun-pty/rust-pty/target/release/librust_pty.so`，或 bun 缓存 `~/.bun/install/cache/bun-pty@<版本>@@@1/rust-pty/target/release/librust_pty.so`）获得；musl 用 `librust_pty_musl.so`。
2. 上传到服务器真实路径，例如 `/opt/opencode/lib/librust_pty.so`。
3. 在 systemd 单元（网关和执行层都要）里加：
   ```ini
   [Service]
   Environment=BUN_PTY_LIB=/opt/opencode/lib/librust_pty.so
   ```
4. `systemctl daemon-reload && systemctl restart opencode-gateway opencode-serve`。

也可以把 `BUN_PTY_LIB` 写进 `--env-file` 对应的 env 文件（进程环境里已有的变量优先于文件，两者都设时以环境变量为准）。

**验证**：`POST /api/pty` 返回 200 且 PTY 为 `running` 即正常。兼容性前提是服务器的 glibc 版本不高于构建该库的机器（依赖仅 `libc`/`libpthread`/`libdl`/`libutil`，RHEL8 均自带）。

## 知识库服务

AI 可以在会话里查询的专业知识库。平台管理员在 设置 → 扩展 → MCP 页的"知识库"一栏建库、编辑条目、导入 Markdown、选择开放给哪些组织、调整检索参数;成员只能用开放给自己组织的库。

- **形态**:`opencode knowledge` 是和 `serve`、`gateway` 并列的一个进程,全平台只跑一个。启动后把地址和 15 秒租约写进 Redis(键 `knowledge:service`),执行层从那里找到它。租约被别的实例持有时,新实例最多等一个租约周期(约 16 秒,让刚重启的自己的旧租约过期),仍拿不到就拒绝启动;失去租约的实例自行退出。
- **没有 Redis 或没有配置时**:执行层在自己进程里跑一份内置的知识服务,数据放在该层的数据目录 `knowledge/knowledge.db`。这只适合本地和单机,多个执行层各有各的库。
- **部署**:`docker compose -f deploy/knowledge.yml --env-file deploy/.env.prod up -d`。数据在卷 `data` 里的 `knowledge.db`,**需要备份**;它是单点,停机期间会话仍能继续,只是知识库工具返回"暂不可用"。
- **配置(环境变量)**

| 变量 | 作用 | 谁需要 |
|---|---|---|
| `OPENCODE_KNOWLEDGE_SECRET` | 执行层调用知识服务时签名用的密钥,两边必须一致 | 知识服务、所有执行层 |
| `OPENCODE_KNOWLEDGE_URL` | 知识服务监听的地址,默认 `http://127.0.0.1:4200` | 知识服务 |
| `OPENCODE_KNOWLEDGE_ADVERTISE_URL` | 写进 Redis、供执行层访问的地址 | 知识服务 |
| `OPENCODE_KNOWLEDGE_DATA` | 数据目录,默认 `./knowledge` | 知识服务 |
| `OPENCODE_KNOWLEDGE_SECRET_PREVIOUS` | 换密钥时保留旧密钥,两边切换完成后删除 | 知识服务 |
| `OPENCODE_REGISTRY_URL` / `OPENCODE_REDIS_URL` | Redis 地址,与网关、执行层用同一个 | 知识服务、执行层 |
| `OPENCODE_KNOWLEDGE_URL`(执行层上) | 不经 Redis,直接指定知识服务地址 | 可选 |

- **安全**:知识服务不认证用户,只信任执行层用上述密钥签名的上下文头(60 秒有效)。端口只开放给内网,不要对外。
- **导入**:导入用服务器基础配置里的默认模型(`opencode.json` 的 `model`),也可以在设置里指定"导入模型"(`供应商/模型`)。转换结果先作为草稿,管理员发布后才会被搜到(设置里关掉"审核"则直接发布)。
  - 文档按标题切成章节,每个章节记下内容的 hash。再次导入同一文档时,没变的章节直接跳过;**改过的章节会生成新条目,旧版本的条目不会自动删除**,需要手动删掉。
  - 同一个知识库同时只能有一个导入任务,前一个没结束时再导入会提示"仍在运行"。任务 10 分钟没有进展视为已中断(例如执行层重启),不再阻挡新的导入。
  - 进度在页面上显示;某个章节模型连续两次没返回规定的 JSON 就记为失败,其他章节继续。全部失败时任务为"失败"。
  - 小模型(如 1.7B)能完成转换,但每个章节要几十秒,问题和别名的质量也一般,正式使用建议换更大的模型。
- **向量检索**:内置向量(内存扫描,int8)开箱即用;外部向量库支持 Qdrant 和 pgvector,在设置里选择类型并填地址。向量需要 embedding 模型,没有时自动只用关键词检索。
  - **选择 embedding 模型**:在设置的"向量模型"里填 `供应商/模型`,例如 `lmstudio/text-embedding-nomic-embed-text-v1.5`。模型目录里 `type` 为 `embedding` 的模型才能用;LM Studio 加载的 embedding 模型会被自动发现。
  - **前缀**:部分模型要求在问题和文档前加固定文字,在"查询前缀""文档前缀"里填。例如 nomic-embed 分别是 `search_query: ` 和 `search_document: `,e5 系列是 `query: ` 和 `passage: `。
  - **超时**:生成查询向量超过 `queryTimeoutMs`(默认 1.5 秒)、向量库超过 `storeTimeoutMs`(默认 0.8 秒)时,相关的库这次只用关键词,结果里 `degraded` 为 `["vector"]`。本地 CPU 跑的模型常常更慢,可以调大。
  - **更换 embedding 模型**:换模型后只有用新模型生成的向量参与检索,旧向量被忽略(维度不同,无法比较)。编辑过标题或正文的条目会用新模型重新生成向量;其余条目在重新生成之前只能靠关键词被搜到。目前没有批量重新生成的按钮。
  - **重建索引**:外部向量库出过故障、或换了向量库地址后,在知识库的"设置 → 向量库"里点"重建索引"(或调用 `POST /api/knowledge/bases/<库 id>/reindex`),从 `knowledge.db` 里保存的向量重建,不会调用模型。
  - **多个知识库一起搜**:每个库可以用不同的 embedding 模型。一起搜索时,执行层为用到的每个模型各生成一次查询向量,每个库用自己模型的向量比较;某个模型不可用时,只有用它的库退回关键词检索。
  - pgvector 的 HNSW 索引最多支持 2000 维,更高维的模型请用内置向量或 Qdrant。
- **检索参数**:关键词的字段权重(标题、别名、问题、正文)、向量权重 `vectorWeight`、融合常数 `rrfK`、向量最低分 `minScore`、返回条数 `topK` 都可以在平台设置里调,也可以按库覆盖。改完可以用评测接口检验:`POST /api/knowledge/bases/<库 id>/eval/cases` 写几组 `{"question", "expected": 条目 id}`,`POST .../eval/run` 运行,返回前 5 条的命中率和耗时中位数;`GET .../eval/runs` 列出历史,每次运行都保存当时的设置,方便对比。页面上暂时没有评测入口。
- **尚未实现的设置**:设置页里的"查询改写""模型重排""结果缓存"(`enhance.*`)目前只保存,不起作用。
- **自定义术语**:在设置的"术语"里加的词(如 `知识库`、`LC_MAIN`)在分词时作为整体保留。保存术语后,受影响的知识库的关键词索引会立即按新术语重建。
- **排查**:
  - 检索结果 `degraded` 为 `["vector"]`:向量库或 embedding 模型不可用,或超时。看执行层日志里的 `knowledge query embedding unavailable`。
  - 写入条目返回 `indexed: false`:向量已存进 `knowledge.db`,只是没写进向量库;恢复后重建索引(见上)。
  - 工具返回"暂不可用"(503):执行层找不到知识服务。检查 Redis 里的 `knowledge:service` 键,以及两边的 `OPENCODE_KNOWLEDGE_SECRET` 是否一致。
  - 架构、检索和导入流程图见根目录 [README.md](../README.md#知识库)。
