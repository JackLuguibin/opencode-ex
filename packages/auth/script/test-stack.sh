#!/bin/sh
# Runs the tests that need Postgres and Redis on the development containers (deploy/.env.dev). They drop tables and clear
# runtime keys, so they get their own database and Redis database (deploy/.env.test), never the ones `dev:app` uses.
set -e
cd "$(dirname "$0")/../../.."
[ -f deploy/.env.dev ] || cp deploy/.env.dev.example deploy/.env.dev
[ -f deploy/.env.test ] || cp deploy/.env.test.example deploy/.env.test
infra="docker compose -f deploy/infra.yml --env-file deploy/.env.dev"
$infra up -d --wait
$infra exec -T postgres psql -U opencode -d opencode -tc "SELECT 1 FROM pg_database WHERE datname = 'opencode_test'" | grep -q 1 ||
  $infra exec -T postgres psql -U opencode -d opencode -c "CREATE DATABASE opencode_test"
set -a
. ./deploy/.env.test
set +a
(cd packages/auth && bun test)
(cd packages/core && bun test test/identity.postgres.test.ts test/session-sync.postgres.test.ts test/usage.postgres.test.ts)
