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
export OPENCODE_IDENTITY_POSTGRES_URL=postgres://opencode:opencode@127.0.0.1:5436/opencode_smoke
export OPENCODE_REGISTRY_URL=redis://127.0.0.1:6380/14
export OPENCODE_ADMIN_EMPLOYEE_ID=smoke-admin
export OPENCODE_ADMIN_PASSWORD=smoke-admin-password

for port in 4201 4202; do
  (cd packages/cli && XDG_DATA_HOME="$root/$port" OPENCODE_ADVERTISE_URL="http://127.0.0.1:$port" \
    exec bun src/index.ts serve --hostname 127.0.0.1 --port "$port" >"$root/runtime-$port.log" 2>&1) &
  pids="$pids $!"
done
(cd packages/auth && OPENCODE_REDIS_URL="$OPENCODE_REGISTRY_URL" OPENCODE_AUTH_PORT=4203 \
  exec bun src/main.ts >"$root/gateway.log" 2>&1) &
pids="$pids $!"

for _ in $(seq 1 60); do
  curl -s -o /dev/null http://127.0.0.1:4203/api/info && [ "$(docker exec auth-redis-1 redis-cli -n 14 keys 'runtime:*' | wc -l)" -ge 2 ] && break
  sleep 1
done

bun deploy/smoke.ts http://127.0.0.1:4203 "$OPENCODE_ADMIN_EMPLOYEE_ID" "$OPENCODE_ADMIN_PASSWORD" || { tail -n 20 "$root"/*.log; exit 1; }

# Both layers run on this machine, so the answers alone cannot tell them apart; the placement table can.
layers="$(docker exec auth-redis-1 redis-cli -n 14 hvals organization-runtime | sort -u | wc -l | tr -d ' ')"
[ "$layers" = 2 ] || { echo "FAIL organizations were placed on $layers layer(s), expected 2"; exit 1; }
echo "ok   the two organizations are pinned to different layers"
