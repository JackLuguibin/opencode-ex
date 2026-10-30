#!/bin/sh
# Starts one execution layer per address in OPENCODE_RUNTIME_URLS (comma separated, set in deploy/.env.dev).
# The first keeps the default data directory; the others get their own under .dev-data/ because each layer owns the
# projects and sessions of the organizations placed on it.
set -a
. ./deploy/.env.dev
set +a
urls=$OPENCODE_RUNTIME_URLS
export OPENCODE_PASSWORD="$OPENCODE_SERVER_PASSWORD"
root=$(pwd)
first=1
trap 'kill 0' INT TERM EXIT
for url in $(echo "$urls" | tr ',' ' '); do
  host=$(bun -p "new URL('$url').hostname")
  port=$(bun -p "new URL('$url').port")
  if [ -n "$first" ]; then
    first=
  else
    mkdir -p "$root/.dev-data/$port"
    export XDG_DATA_HOME="$root/.dev-data/$port/data" XDG_CONFIG_HOME="$root/.dev-data/$port/config" XDG_STATE_HOME="$root/.dev-data/$port/state" XDG_CACHE_HOME="$root/.dev-data/$port/cache"
  fi
  (cd packages/cli && OPENCODE_ADVERTISE_URL="$url" exec bun --watch --env-file=../../deploy/.env.dev src/index.ts serve --hostname "$host" --port "$port") &
done
wait
