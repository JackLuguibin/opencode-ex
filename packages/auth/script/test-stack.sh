#!/bin/sh
# Runs the tests that need Postgres and Redis against the containers from `bun run dev:infra`. They drop tables and
# clear runtime keys, so they get their own database and Redis database 15, never the ones `dev:app` uses.
set -e
cd "$(dirname "$0")/../../.."
docker exec auth-postgres-1 psql -U opencode -d opencode -tc "SELECT 1 FROM pg_database WHERE datname = 'opencode_test'" | grep -q 1 ||
  docker exec auth-postgres-1 psql -U opencode -d opencode -c "CREATE DATABASE opencode_test"
export OPENCODE_TEST_POSTGRES_URL=postgres://opencode:opencode@127.0.0.1:5436/opencode_test
export OPENCODE_TEST_REDIS_URL=redis://127.0.0.1:6380/15
(cd packages/auth && bun test)
(cd packages/core && bun test test/identity.postgres.test.ts)
