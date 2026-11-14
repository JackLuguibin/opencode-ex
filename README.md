# opencode-ex

基于完整 OpenCode 仓库，移除 Electron 桌面应用及官网营销内容。保留 Web 应用、CLI、服务端、TUI、SDK 和插件；文档站点已删除。完整上游副本位于同级 `../opencode-base`，来源提交见 `UPSTREAM.json`。

## 本地运行

使用 Bun 1.4.4，在根目录安装依赖：

```sh
bun install
```

一条命令启动完整环境：Postgres 与 Redis（docker）、一个执行层（4097）、Auth 网关（4100）和 Web 前端：

```sh
bun run dev:app
```

需要 Docker。也可以分开启动：`bun run dev:infra`、`bun run dev:runtime`、`bun run dev:gateway`、`bun run dev:web`。想再加一个执行层，换一个端口和数据目录再起一次 `dev:runtime`（见 [packages/auth/README.md](packages/auth/README.md)）。

Web 默认地址为 `http://localhost:3000`，只和 Auth 网关（`http://127.0.0.1:4100`）通信，并先显示工号和密码的登录页，不再自动带上服务器密码。账号存放在 Postgres，项目和会话存放在各执行层自己的数据库，一个组织固定在一个执行层上。

网页账号和命令行用的服务器密码不是一回事。网页用工号登录。普通用户注册后还没有组织，要等平台管理员把工号加入某个租户才能进入主界面。项目归属于创建时所在的组织，切换组织后只能看到当前组织下的项目。只有平台管理员能新建租户。

第一个管理员不能靠网页注册产生。在 `deploy/.env.dev`（已被 git 忽略，不会提交；缺失时 `bun run dev:infra` 会从 `deploy/.env.dev.example` 复制）写上：

```sh
OPENCODE_ADMIN_EMPLOYEE_ID=管理员工号
OPENCODE_ADMIN_PASSWORD=至少8位的管理员密码
OPENCODE_SERVER_PASSWORD=你的测试密码
VITE_OPENCODE_SERVER_HOST=127.0.0.1
VITE_OPENCODE_SERVER_PORT=4100
```

执行层启动时，如果还没有管理员，就用上面的工号和密码创建一次。之后再改这两项不会覆盖已有管理员。`OPENCODE_SERVER_PASSWORD` 仍是命令行和本机脚本的操作者密码，能看到全部项目；网页不发送它。监听非本机地址时必须设置该密码，否则后端会生成随机密码。启动命令都会读取这个文件；网关密钥、Postgres 和 Redis 地址有开发默认值，需要时可在同一文件里用 `OPENCODE_GATEWAY_SECRET`、`OPENCODE_IDENTITY_POSTGRES_URL`、`OPENCODE_REGISTRY_URL` 覆盖。CLI / TUI 使用 `bun dev`，Web 构建使用 `bun run --cwd packages/app build`。

## 架构

浏览器只和 Auth 网关通信，网关再把请求转给执行层。账号和组织放在共享 Postgres，Redis 只存心跳和租约，项目、会话和文件留在各执行层自己的 SQLite。知识库是全平台共用的一个独立进程，只有执行层能调用它，见[知识库](#知识库)。

### 组件

```mermaid
flowchart LR
    Web["Web 应用<br/>(浏览器)"]
    subgraph Gateway["Auth 网关 (opencode gateway :4100)"]
        Proxy["认证 + 反向代理<br/>HMAC 签名 x-opencode-actor"]
        Place["组织放置<br/>(2 秒内存缓存)"]
    end
    subgraph Shared["共享服务"]
        PG[("Postgres<br/>账号 / 组织 / 登录会话<br/>组织放置表 / 会话分析副本")]
        Redis[("Redis<br/>执行层租约和心跳<br/>登录限流 / 全局包修订号")]
    end
    subgraph L1["执行层 1 (opencode serve)"]
        RT1["Session 执行 / 工具 / 模型"]
        DB1[("SQLite<br/>项目 / 会话 / 消息 / 文件<br/>个人凭证")]
        Sync1["SessionSync<br/>每 60 秒"]
    end
    subgraph LN["执行层 2..N"]
        RTN["同执行层 1"]
    end
    subgraph KS["知识库服务 (opencode knowledge :4200，全平台一个)"]
        KB["条目 / 检索 / 设置"]
        KDB[("knowledge.db<br/>SQLite + FTS5 + 向量")]
    end
    Emb["模型供应商<br/>embedding / 导入用的对话模型"]

    Web -->|"HTTPS /api"| Proxy
    Proxy -->|"校验登录令牌"| PG
    Proxy -.->|"用量查询（读共享 PG，由组织所在的执行层处理）"| RT1
    Proxy --> Place
    Place -->|"读写放置"| PG
    Place -->|"在线层列表"| Redis
    Proxy -->|"签名后的请求"| RT1
    Proxy -->|"签名后的请求"| RTN
    Proxy -.->|"全局写入广播<br/>(全局包 / 共享 MCP / 平台设置)"| RT1
    Proxy -.->|"全局写入广播"| RTN
    RT1 --> DB1
    RT1 -->|"登记 + 心跳"| Redis
    RT1 -->|"镜像用户和组织"| PG
    RTN -->|"登记 + 心跳"| Redis
    DB1 --> Sync1
    RT1 -->|"x-opencode-knowledge<br/>(HMAC 签名，60 秒)"| KB
    RTN -->|"x-opencode-knowledge"| KB
    RT1 -->|"文本向量化 / 文档转换"| Emb
    KB --> KDB
    KB -->|"登记 + 15 秒租约"| Redis
    Sync1 -->|"幂等 upsert<br/>(脱敏)"| PG
```

- 一个组织第一次使用时固定到一个执行层（持有组织最少的，其次负载最低），之后不再迁移；那一层离线时该组织返回 503，不会换到没有它数据的层。
- 身份类路由（`/api/auth/*`、`/api/organization*` 等）直接带用户自己的令牌，其他路由带网关签名的 actor，执行层看不到用户令牌。
- 删除组织必须到达它所在的执行层，网关按路径中的组织路由，收到 2xx 后才释放放置记录。

### 一次请求

```mermaid
sequenceDiagram
    autonumber
    actor U as 用户
    participant W as Web 应用
    participant G as Auth 网关
    participant P as Postgres
    participant R as Redis
    participant L as 执行层
    participant S as SQLite

    U->>W: 工号 + 密码登录
    W->>G: POST /api/auth/login
    G->>P: 校验账号，写入登录会话
    G-->>W: 会话令牌

    U->>W: 打开项目 / 发送消息
    W->>G: /api/... (带令牌)
    G->>P: 令牌 → 用户和当前组织
    G->>P: 查组织放置
    alt 组织还没放置
        G->>R: 取在线执行层及负载
        G->>P: INSERT ... ON CONFLICT DO NOTHING（先写者赢）
    end
    alt 所在执行层离线
        G-->>W: 503
    else 在线
        G->>L: 转发 + x-opencode-actor (HMAC 签名)
        L->>L: 验签，镜像用户和组织行
        L->>S: 读写项目、会话、消息（用户消息记下发送人 user_id）
        L-->>G: 响应
        G-->>W: 响应
    end

    loop 每 60 秒（可用 OPENCODE_SESSION_SYNC_INTERVAL 调整，0 关闭）
        L->>S: 读游标之后变化的会话 / 消息 / 项目
        L->>P: 脱敏后幂等写入 session_sync_*（助手消息继承前一条提示的发送人）
        L->>S: 推进游标
    end
```

### 共享 Postgres 的表

```mermaid
erDiagram
    identity_user ||--o{ identity_membership : "属于"
    identity_organization ||--o{ identity_membership : "包含"
    identity_user ||--o{ identity_session : "登录"
    identity_organization |o--o{ identity_session : "当前组织"
    identity_organization ||--o| organization_placement : "固定在某执行层"
    identity_organization ||..o{ session_sync_project : "逻辑关联，无外键"
    identity_organization ||..o{ session_sync_session : "逻辑关联，无外键"
    session_sync_project ||..o{ session_sync_session : "runtime_id + project_id"
    session_sync_session ||..o{ session_sync_message : "session_id"
    identity_user ||--o{ identity_user_credential : "用户的全局密钥"
    identity_user ||..o{ session_sync_message : "发送人 user_id，逻辑关联，无外键"

    identity_user {
        text id PK
        text employee_id UK
        boolean admin
    }
    identity_organization {
        text id PK
        text name
        boolean session_sync "关闭后不再同步该组织的会话"
    }
    identity_membership {
        text organization_id PK
        text user_id PK
        text role
    }
    identity_session {
        text id PK
        text token_hash UK
        text user_id FK
        text organization_id FK
    }
    identity_user_credential {
        text user_id PK
        text integration_id PK
        text value_encrypted "AES-256-GCM 封存"
        text hint "密钥最后 4 位"
    }
    organization_placement {
        text organization_id PK
        text runtime_id "组织所在的执行层"
    }
    session_sync_project {
        text runtime_id PK
        text project_id PK
        text organization_id
        text created_by_user_id
    }
    session_sync_session {
        text session_id PK
        text organization_id
        text runtime_id
        text project_id
        text holder_user_id
        text created_by_user_id
        double cost
    }
    session_sync_message {
        text session_id PK
        int seq PK
        text project_id
        text user_id "发送人"
        text organization_id
        text model "provider/model，仅模型调用有"
        double cost "仅模型调用有"
        bigint tokens_input "还有 output、reasoning、cache_read、cache_write"
        jsonb data "脱敏后的内容"
    }
```

`session_sync_*` 三张表是给分析用的副本，故意不建外键，分析时用 LEFT JOIN。消息有发送人 `user_id`，模型调用的消息还带有 `cost`、`tokens_*` 和 `model`（用量页就按这些汇总）。发送人：用户消息是提交它的人，助手消息取它之前最近一条用户消息的发送人；这一版之前的旧消息没有发送人（为空），不回填。会话上另有持有人和创建人。

### 知识库

AI 在会话里通过 `knowledge_list` / `knowledge_search` / `knowledge_get` 三个工具查专业知识；管理员在 设置 → 扩展 → MCP 页的"知识库"一栏维护。知识库服务不认证用户，也不调用模型：执行层验明身份、生成向量、调用模型转换文档，再把结果连同签名的上下文头（`x-opencode-knowledge`，60 秒有效）一起发给它。部署和配置见 [deploy/README.md](deploy/README.md#知识库服务)。

#### 模块

```mermaid
classDiagram
    direction LR
    class KnowledgeTools {
        <<core/tool/plugin/knowledge.ts>>
        knowledge_list()
        knowledge_search(query, base?, limit?)
        knowledge_get(id)
        -queryVector(base, query)
    }
    class KnowledgeHandler {
        <<server/handlers/knowledge.ts>>
        路由 /api/knowledge/…
        -forward(method, path)
        -embedTexts(base, texts)
        -startImport(base, markdown)
    }
    class KnowledgeClient {
        <<core/knowledge.ts>>
        call(actor, request) Answer
        -discover() 读 Redis，缓存 5 秒
        -inProcess() 没配置时内置一份
    }
    class Embedding {
        <<core/embedding.ts>>
        embed(texts) 64 条一批
        embedQuery(text) 带缓存和超时
    }
    class KnowledgeImport {
        <<core/knowledge-import.ts>>
        split(markdown) Section[]
        prompt(section) string
        parse(reply) Converted[]
    }
    class Server {
        <<knowledge/server.ts>>
        路由 /v1/…
        Context.verify(header)
    }
    class Knowledge {
        <<knowledge/knowledge.ts>>
        search(context, input)
        bases / entries / settings
        reindex / jobs / evaluation
        -fuse() RRF 融合
    }
    class Settings {
        <<knowledge/settings.ts>>
        defaults
        apply(base, patch) 校验范围
        redact() 隐藏密钥
    }
    class Tokenize {
        <<knowledge/tokenize.ts>>
        words() Intl.Segmenter 中文分词
        match() FTS5 表达式
    }
    class VectorStore {
        <<interface>>
        ensure / upsert / remove / drop
        search(collection, vec, limit)
        health()
    }
    class Builtin {
        内存 int8 精确扫描
    }
    class Qdrant {
        REST API
    }
    class Pgvector {
        每库一表 + HNSW
    }

    KnowledgeTools --> KnowledgeClient : 签名调用
    KnowledgeTools --> Embedding : 查询向量
    KnowledgeHandler --> KnowledgeClient : 转发
    KnowledgeHandler --> Embedding : 条目向量
    KnowledgeHandler --> KnowledgeImport : 导入
    KnowledgeClient --> Server : HTTP
    Server --> Knowledge
    Knowledge --> Settings
    Knowledge --> Tokenize
    Knowledge --> VectorStore
    VectorStore <|.. Builtin
    VectorStore <|.. Qdrant
    VectorStore <|.. Pgvector
```

- 向量总是先存进 `knowledge.db` 的 `entry_vec`，向量库只是可以从那里重建的索引。向量库写失败不会让写入失败，条目返回 `indexed: false`，之后用"重建索引"补齐。
- 设置分两层：平台设置对所有库生效，每个库只保存自己覆盖的部分（`kb.settings`），用时叠加在平台设置上。

#### 一次检索

```mermaid
sequenceDiagram
    autonumber
    participant A as Agent（会话）
    participant T as knowledge_search 工具
    participant E as Embedding
    participant C as Knowledge 客户端
    participant K as 知识库服务
    participant F as FTS5（entry_fts）
    participant V as 向量库

    A->>T: query, base?
    T->>T: 权限确认
    T->>C: POST /v1/search/models {bases?}
    C->>K: 签名请求
    K-->>T: 这些库用到的每个模型的 model / queryPrefix
    par 每个模型
        T->>E: embedQuery(queryPrefix + query)
        E-->>T: 归一化向量（失败或超时则不带这个模型的向量）
    end
    T->>C: POST /v1/search {query, vectors: {模型: 向量}, bases?, topK}
    C->>K: 签名请求
    K->>K: 验签，筛出该组织能用的库
    par 每个库
        K->>F: 分词 → MATCH，bm25 按字段加权，前 50
        K->>V: 用这个库模型的向量查相似度前 50（超时 storeTimeoutMs）
        K->>K: 标题 / 别名完全相同
    end
    K->>K: RRF 融合，按分数取 topK
    K-->>T: hits + degraded（模型或向量库不可用时为 ["vector"]）
    T-->>A: 条目标题、摘要、片段、来源
```

每个库的分数：关键词第 r 名得 `1 / (rrfK + r)`，向量第 r 名得 `vectorWeight / (rrfK + r)`（低于 `minScore` 的不计），标题或别名与查询完全相同再加 1。多个库的结果合在一起按分数排序。

#### 导入 Markdown

```mermaid
sequenceDiagram
    autonumber
    participant U as 管理员页面
    participant H as 执行层
    participant M as 导入模型
    participant E as Embedding
    participant K as 知识库服务

    U->>H: POST /api/knowledge/bases/:id/import {markdown, name}
    H->>K: 读库设置、已导入的章节 hash
    H->>H: 按标题切成章节（不超过 chunkChars，不切开代码块）
    H->>K: 建导入任务 total = 新章节数
    H-->>U: job id（hash 没变的章节跳过）
    loop 每个新章节（并发 concurrency）
        H->>M: 转换提示词
        M-->>H: {"entries": [...]}（格式不对重试一次）
        H->>E: 条目向量
        H->>K: POST entries（review 开启时为草稿）
        H->>K: PATCH 任务进度 done + 1
    end
    H->>K: 任务结束：全部失败为 failed，否则 done
    loop 每 1.5 秒
        U->>H: GET /api/knowledge/jobs/:id
    end
```

#### 状态

```mermaid
stateDiagram-v2
    state "条目" as Entry {
        [*] --> draft: 导入且开启审核 / 手动存为草稿
        [*] --> published: 手动添加 / 导入且不审核
        draft --> published: 发布（单条或全部）
        published --> draft: 撤回
        published --> [*]: 删除
        draft --> [*]: 删除
    }
    state "导入任务" as Job {
        [*] --> running
        running --> done: 至少一个章节成功
        running --> failed: 全部章节失败或转换中断
    }
```

只有 `published` 的条目会进关键词索引和向量索引；成员看不到草稿。改标题或正文会丢弃旧向量并重新生成，只改状态会保留向量。

#### knowledge.db

```mermaid
erDiagram
    kb ||--o{ kb_grant : "开放给"
    kb ||--o{ entry : "包含"
    entry ||--o| entry_vec : "向量"
    entry ||--o| entry_fts : "关键词索引（rowid = seq，仅已发布）"
    kb ||--o{ import_job : "导入"
    kb ||--o{ eval_case : "评测问题"
    kb ||--o{ eval_run : "评测记录"
    entry ||..o{ eval_case : "期望命中，无外键"

    kb {
        text id PK "kb_..."
        text name
        text description
        text settings "覆盖平台设置的部分（JSON）"
    }
    kb_grant {
        text kb_id PK
        text organization_id PK
    }
    entry {
        int seq PK
        text id UK "ke_..."
        text kb_id FK
        text title
        text content
        text summary
        text aliases "JSON 数组"
        text questions "JSON 数组"
        text keywords "JSON 数组"
        text source "import:文件名#标题路径"
        text status "draft / published"
        text hash "导入章节的 sha1，重新导入时跳过"
    }
    entry_vec {
        text entry_id PK
        text model "生成它的 embedding 模型"
        int dim
        blob vec "float32，已归一化"
    }
    entry_fts {
        text kb_id
        text title "分词后的文本"
        text aliases
        text questions
        text content "摘要 + 正文"
        text keywords
    }
    import_job {
        text id PK
        text status "running / done / failed"
        int total
        int done
        text error
    }
    eval_case {
        text id PK
        text question
        text expected_entry_id
    }
    eval_run {
        text id PK
        int cases
        real recall_at_5
        real p50_ms
        text settings "运行时的设置快照"
    }
```

另有 `platform_setting` 一张表，只有一行，存平台设置（向量库密钥只能写不能读，页面上只显示是否已设置）。

## 上游业务残留清理

已移除 Salesforce、官方统计站点及代理、Enterprise 反向代理和官方登录跳转、桌面更新接口、上游专用脚本与无引用截图。免费额度用尽时不再弹出 OpenCode Go 订阅窗，也不再打开官方免费模型选择。设置里的 OpenCode Free 分组、后端目录和未登录时的公开密钥配置一并移除。会话里仍保留额度说明，并把刚才的内容放回输入框；已经接入的模型继续用原来的模型列表选择。保留核心用量统计、CLI 更新查询与文件下载。云配置仅保留 ex 的 Cloudflare 资源；自定义域名通过环境变量配置，见 [部署说明](infra/README.md)。

## 本轮残留清理

已删除退役分享 Worker、官方 iOS 关联、旧仓库维护者名单、上游发布签名及 Issue/PR 自动管理脚本。CLI 本地构建与打包命令仍保留。

文档代理（`packages/console/app`）连接外部文档服务：生产构建通过 `VITE_OPENCODE_EX_V2_DOCS_URL` 配置，未配置返回 503；V1 地址不再提供。

## CI 状态

GitHub Actions 暂停，所有工作流已移至 `.github/workflows-disabled/`。重新启用前需要适配本仓库的分支、runner 与部署目标；本地检查和推送钩子仍保留。

## 官网裁剪范围

已删除 `services/www`（V2 文档站）和 `packages/web`（V1 文档站），本仓库不再自带文档站点。

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
