# Auth gateway

In a release the gateway is the `opencode gateway` command (same binary as the execution layer, also serving the web app); `bun src/main.ts` runs the same code in development. Settings come from environment variables, or from a file with `--env-file` / `OPENCODE_ENV_FILE`; see [deploy/README.md](../../deploy/README.md).

Sits between the web app and the execution layers (`opencode serve`). The browser only talks to this process.

```
Web ──> Auth (proxy) ──signed actor──> execution layer 1..N
          │                               │
          └── Redis: runtime leases ─┘── Postgres: accounts, organizations, sessions, placement
```

- **Accounts** (users, organizations, roles, login sessions) live in a shared Postgres, so any execution layer can
  authenticate any user.
- **Projects, sessions and files** live in each execution layer's own database. An organization is pinned to one layer
  the first time it is used (fewest organizations first, then least load) and stays there. If that layer is offline the
  organization answers 503 instead of moving to a layer without its data.
- Writes every layer must agree on (global packages, shared MCP servers, platform config) are sent to all layers.
- Identity routes (`/api/auth/*`, `/api/organization*`, …) carry the user's own token; everything else carries a signed
  actor (`Gateway.sign`), so execution layers never see user tokens on those routes.

## Run locally

```bash
bun run dev:infra               # from the repo root: Postgres :5436, Redis :6380 (deploy/infra.yml with deploy/.env.dev)

# execution layers (one per port; each needs its own data directory)
OPENCODE_PASSWORD=operator \
OPENCODE_GATEWAY_SECRET=secret \
OPENCODE_IDENTITY_POSTGRES_URL=postgres://opencode:opencode@127.0.0.1:5436/opencode \
OPENCODE_REGISTRY_URL=redis://127.0.0.1:6380 \
OPENCODE_ADVERTISE_URL=http://127.0.0.1:4297 \
OPENCODE_ADMIN_EMPLOYEE_ID=admin OPENCODE_ADMIN_PASSWORD=change-me-123 \
  bun packages/cli/src/index.ts serve --port 4297

# the gateway
OPENCODE_GATEWAY_SECRET=secret OPENCODE_REDIS_URL=redis://127.0.0.1:6380 OPENCODE_AUTH_URL=http://127.0.0.1:4100 \
  bun packages/auth/src/main.ts
```

Point the web app at the gateway (`VITE_OPENCODE_SERVER_URL=http://127.0.0.1:4100`). Without Redis, set `OPENCODE_UPSTREAM_URL` to a
single execution layer instead of `OPENCODE_REDIS_URL`.

Tests that need Postgres or Redis are skipped unless `OPENCODE_TEST_POSTGRES_URL` / `OPENCODE_TEST_REDIS_URL` are set.

## Dev

`bun run dev:app` (repo root) starts Postgres and Redis, one execution layer on :4097, the gateway on :4100 and the web
app pointed at it. A second execution layer: `OPENCODE_ADVERTISE_URL=http://127.0.0.1:4098 XDG_DATA_HOME=... bun run dev:runtime` (each layer
needs its own data directory). All variables can be set in `deploy/.env.dev`.

## Deploy

`deploy/` holds a source image (`Dockerfile`, targets `app` and `web`), `docker-compose.yml` (Postgres, Redis, Auth, two
execution layers, web) and `nginx.conf`. Copy `deploy/.env.prod.example` to `deploy/.env.prod`, change the secrets, then:

```bash
docker compose -f deploy/docker-compose.yml --env-file deploy/.env up -d --build
```

The web front serves the built app on `WEB_PORT` (default 8080) and proxies `/api` to Auth.

## Moving an existing single-machine database

Accounts move to Postgres with their IDs unchanged, so projects, sessions and credentials stay attached. Stop the
execution layers, then:

```bash
bun run --cwd packages/core migrate-identity -- --from ~/.local/share/opencode/opencode-local.db \
  --to postgres://opencode:opencode@127.0.0.1:5436/opencode --replace
```

`--replace` removes the accounts already in the target (for example an admin created from `deploy/.env.dev`). Without it the
script refuses a target that has accounts. Start the execution layer on the same data directory afterwards: it keeps the
projects and sessions, and an organization is pinned to the layer the first time anyone uses it.

## 测试

`bun run test:stack`（仓库根目录，需先 `bun run dev:infra`）用独立的库 `opencode_test` 和 Redis 库 15 跑依赖 Postgres/Redis 的测试；`bun run test:smoke` 起两个执行层加网关，走一遍登录、拒绝、组织固定。
