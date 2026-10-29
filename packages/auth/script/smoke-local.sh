#!/bin/sh
# Brings up a throwaway stack (two execution layers and the gateway, on ports 4201-4203) against the containers from
# `bun run dev:infra`, runs deploy/smoke.ts through the gateway, and tears it all down. It uses its own database
# (`opencode_smoke`), Redis database 14 and a temporary data directory, so `dev:app` is left alone.
set -e
cd "$(dirname "$0")/../../.."
docker exec auth-postgres-1 psql -U opencode -d opencode -c "DROP DATABASE IF EXISTS opencode_smoke" >/dev/null
docker exec auth-postgres-1 psql -U opencode -d opencode -c "CREATE DATABASE opencode_smoke" >/dev/null
docker exec auth-redis-1 redis-cli -n 14 flushdb >/dev/null

root="$(mktemp -d)"
pids=""
trap 'kill $pids 2>/dev/null || true; rm -rf "$root"' EXIT

export OPENCODE_PASSWORD=smoke-operator
export OPENCODE_GATEWAY_SECRET=smoke-gateway
# Mid-rotation: the layers still sign with the old key but also accept the new one, which the gateway already uses.
export OPENCODE_GATEWAY_SECRET_EXTRA=smoke-gateway-next
export OPENCODE_IDENTITY_POSTGRES_URL=postgres://opencode:opencode@127.0.0.1:5436/opencode_smoke
export OPENCODE_REGISTRY_URL=redis://127.0.0.1:6380/14
export OPENCODE_ADMIN_EMPLOYEE_ID=smoke-admin
export OPENCODE_ADMIN_PASSWORD=smoke-admin-password

for port in 4201 4202; do
  (cd packages/cli && XDG_DATA_HOME="$root/$port" OPENCODE_ADVERTISE_URL="http://127.0.0.1:$port" \
    exec bun src/index.ts serve --hostname 127.0.0.1 --port "$port" >"$root/runtime-$port.log" 2>&1) &
  pids="$pids $!"
done
(cd packages/auth && OPENCODE_GATEWAY_SECRET=smoke-gateway-next OPENCODE_REDIS_URL="$OPENCODE_REGISTRY_URL" OPENCODE_AUTH_PORT=4203 \
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

placements() { docker exec auth-redis-1 redis-cli -n 14 hlen organization-runtime; }

# First run keeps its organizations. Both layers run on this machine, so the answers alone cannot tell them apart; the
# placement table can.
SMOKE_KEEP=1 bun deploy/smoke.ts http://127.0.0.1:4203 "$OPENCODE_ADMIN_EMPLOYEE_ID" "$OPENCODE_ADMIN_PASSWORD" || { tail -n 20 "$root"/*.log; exit 1; }
layers="$(docker exec auth-redis-1 redis-cli -n 14 hvals organization-runtime | sort -u | wc -l | tr -d ' ')"
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
