#!/bin/sh
# Brings up a throwaway stack (two execution layers and the gateway, on ports 4201-4203) against the containers from
# development Postgres and Redis (deploy/.env.dev), runs deploy/smoke.ts through the gateway, and tears it all down. It uses its own database
# (`opencode_smoke`), Redis database 14 and a temporary data directory, so `dev:app` is left alone.
set -e
cd "$(dirname "$0")/../../.."
[ -f deploy/.env.dev ] || cp deploy/.env.dev.example deploy/.env.dev
[ -f deploy/.env.test ] || cp deploy/.env.test.example deploy/.env.test
infra="docker compose -f deploy/infra.yml --env-file deploy/.env.dev"
$infra up -d --wait
$infra exec -T postgres psql -U opencode -d opencode -c "DROP DATABASE IF EXISTS opencode_smoke" >/dev/null
$infra exec -T postgres psql -U opencode -d opencode -c "CREATE DATABASE opencode_smoke" >/dev/null
$infra exec -T redis redis-cli -n 14 flushdb >/dev/null
set -a
. ./deploy/.env.test
set +a

root="$(mktemp -d)"
pids=""
trap 'kill $pids 2>/dev/null || true; rm -rf "$root"' EXIT

export OPENCODE_PASSWORD=smoke-operator
export OPENCODE_GATEWAY_SECRET=smoke-gateway
# Mid-rotation: the layers still sign with the old key but also accept the new one, which the gateway already uses.
export OPENCODE_GATEWAY_SECRET_EXTRA=smoke-gateway-next
export OPENCODE_IDENTITY_POSTGRES_URL="$OPENCODE_SMOKE_POSTGRES_URL"
export OPENCODE_REGISTRY_URL="$OPENCODE_SMOKE_REDIS_URL"
# Copy sessions to Postgres every two seconds instead of every minute, so the check at the end does not wait.
export OPENCODE_SESSION_SYNC_INTERVAL=2
export OPENCODE_ADMIN_EMPLOYEE_ID=smoke-admin
export OPENCODE_ADMIN_PASSWORD=smoke-admin-password

start_layer() {
  (cd packages/cli && XDG_DATA_HOME="$root/$1" OPENCODE_ADVERTISE_URL="http://127.0.0.1:$1" \
    exec bun src/index.ts serve --hostname 127.0.0.1 --port "$1" >>"$root/runtime-$1.log" 2>&1) &
  layer_pid=$!
  pids="$pids $layer_pid"
}
start_layer 4201
start_layer 4202
pid_4202=$layer_pid
(cd packages/auth && OPENCODE_GATEWAY_SECRET=smoke-gateway-next OPENCODE_REDIS_URL="$OPENCODE_REGISTRY_URL" OPENCODE_AUTH_URL=http://127.0.0.1:4203 \
  exec bun src/main.ts >"$root/gateway.log" 2>&1) &
pids="$pids $!"

for _ in $(seq 1 60); do
  curl -s -o /dev/null http://127.0.0.1:4203/api/info && [ "$(docker exec auth-redis-1 redis-cli -n 14 keys 'runtime:*' | wc -l)" -ge 2 ] && break
  sleep 1
done

# Probes need no credentials: both layers are ready, and the gateway sees both of them.
for port in 4201 4202; do
  curl -fs http://127.0.0.1:$port/ready | grep -q '"state":"ready"' || { echo "FAIL layer $port is not ready"; exit 1; }
done
curl -fs http://127.0.0.1:4203/health | grep -q '"runtimes":2' || { echo "FAIL the gateway does not report two layers"; exit 1; }
echo "ok   layers are ready and the gateway reports two of them"

placements() { docker exec auth-postgres-1 psql -U opencode -d opencode_smoke -tAc "SELECT count(*) FROM organization_placement"; }

# First run keeps its organizations. Both layers run on this machine, so the answers alone cannot tell them apart; the
# placement table can.
SMOKE_KEEP=1 bun deploy/smoke.ts http://127.0.0.1:4203 "$OPENCODE_ADMIN_EMPLOYEE_ID" "$OPENCODE_ADMIN_PASSWORD" || { tail -n 20 "$root"/*.log; exit 1; }
layers="$(docker exec auth-postgres-1 psql -U opencode -d opencode_smoke -tAc "SELECT count(DISTINCT runtime_id) FROM organization_placement")"
[ "$layers" = 2 ] || { echo "FAIL organizations were placed on $layers layer(s), expected 2"; exit 1; }
echo "ok   the two organizations are pinned to different layers"

# Second run creates two more and deletes one: the table must grow by one, not two.
before="$(placements)"
out="$(bun deploy/smoke.ts http://127.0.0.1:4203 "$OPENCODE_ADMIN_EMPLOYEE_ID" "$OPENCODE_ADMIN_PASSWORD")" || { echo "$out"; tail -n 20 "$root"/*.log; exit 1; }
echo "$out"
after="$(placements)"
[ "$after" = "$((before + 1))" ] || { echo "FAIL placements went from $before to $after, expected one more"; exit 1; }
echo "ok   a deleted organization's placement was released"

# Its directory (made when its member started a session) must be gone from whichever layer held it, and others stay.
gone="$(echo "$out" | sed -n 's/^deleted organization //p')"
[ -n "$gone" ] && [ -z "$(find "$root" -type d -name "$gone" 2>/dev/null)" ] || { echo "FAIL the deleted organization's directory is still on disk"; exit 1; }
[ -n "$(find "$root" -type d -name 'org_*' 2>/dev/null)" ] || { echo "FAIL no organization directories exist at all; the check above proves nothing"; exit 1; }
echo "ok   a deleted organization's files are removed"

# Sessions are copied to Postgres by the layer that holds them, so copies from both layers must show up.
copied() { docker exec auth-postgres-1 psql -U opencode -d opencode_smoke -tAc "SELECT count(DISTINCT runtime_id) FROM session_sync_session"; }
for _ in $(seq 1 20); do [ "$(copied)" = 2 ] && break; sleep 1; done
[ "$(copied)" = 2 ] || { echo "FAIL sessions were copied from $(copied) layer(s), expected 2"; tail -n 20 "$root"/runtime-*.log; exit 1; }
echo "ok   sessions from both layers are copied to Postgres"

# A layer that was down when a global change was made copies it when it returns. Shared MCP servers are global state
# every layer must agree on; layer 4202 misses the write and must end up with it anyway.
token="$(curl -fs -X POST http://127.0.0.1:4203/api/auth/login -H 'content-type: application/json' \
  -d "{\"employeeID\":\"$OPENCODE_ADMIN_EMPLOYEE_ID\",\"password\":\"$OPENCODE_ADMIN_PASSWORD\"}" | sed -n 's/.*"token":"\([^"]*\)".*/\1/p')"
[ -n "$token" ] || { echo "FAIL could not sign in to change global state"; exit 1; }
auth="authorization: Basic $(printf 'opencode:%s' "$token" | base64 | tr -d '\n')"
kill "$pid_4202"
while kill -0 "$pid_4202" 2>/dev/null; do sleep 0.2; done
curl -fs -o /dev/null -X POST http://127.0.0.1:4203/api/shared-mcp -H "$auth" -H 'content-type: application/json' \
  -d '{"name":"smoke-docs","type":"remote","url":"https://example.com/mcp","organizations":[]}' || { echo "FAIL the shared MCP write was refused"; exit 1; }
has() { grep -qs smoke-docs "$root"/$1/*/organization-packages/mcp.json; }
has 4201 || { echo "FAIL the running layer did not take the shared MCP write"; exit 1; }
has 4202 && { echo "FAIL the stopped layer cannot have the write yet"; exit 1; }
start_layer 4202
for _ in $(seq 1 60); do has 4202 && break; sleep 1; done
has 4202 || { echo "FAIL layer 4202 did not copy the shared MCP server it missed"; tail -n 20 "$root/runtime-4202.log"; exit 1; }
echo "ok   a layer that was down copies the global change it missed"

# Deleting it is global too, and both layers are current again, so both take it.
curl -fs -o /dev/null -X DELETE http://127.0.0.1:4203/api/shared-mcp/smoke-docs -H "$auth" || { echo "FAIL the shared MCP delete was refused"; exit 1; }
has 4201 || has 4202 && { echo "FAIL the shared MCP server is still on a layer after deleting it"; exit 1; }
echo "ok   a global change reaches every layer that is up"
