// Copies the accounts of a single-machine opencode database (users, organizations, memberships, login sessions) into
// the shared Postgres, keeping every ID so the projects, sessions and credentials that point at them stay valid.
//
//   bun run migrate-identity --from ~/.local/share/opencode/opencode-local.db --to postgres://... [--replace]
//
// Stop the execution layers first. Without --replace the target must hold no accounts yet; with it, the target's
// accounts (such as an admin created from the environment) are removed before copying.
import { Database } from "bun:sqlite"
import { parseArgs } from "node:util"
import { Postgres } from "@opencode/util/postgres"
import { migrations } from "../src/identity/postgres"

const { values } = parseArgs({
  options: { from: { type: "string" }, to: { type: "string" }, replace: { type: "boolean" } },
})
if (!values.from || !values.to) {
  console.error("usage: migrate-identity --from <sqlite file> --to <postgres url> [--replace]")
  process.exit(1)
}

const source = new Database(values.from, { readonly: true })
const rows = <T>(query: string) => source.query(query).all() as T[]
const users = rows<{
  id: string
  employee_id: string
  password_hash: string
  admin: number
  time_created: number
  time_updated: number
}>("SELECT * FROM identity_user")
const organizations = rows<{
  id: string
  name: string
  settings_pages: string | null
  time_created: number
  time_updated: number
}>("SELECT * FROM identity_organization")
const memberships = rows<{
  organization_id: string
  user_id: string
  role: string
  time_created: number
  time_updated: number
}>("SELECT * FROM identity_membership")
const sessions = rows<{
  id: string
  token_hash: string
  user_id: string
  organization_id: string | null
  expires_at: number
  time_created: number
  time_updated: number
}>("SELECT * FROM identity_session")
source.close()

const sql = Postgres.connect(values.to)
await Postgres.migrate(sql, migrations)
await sql.begin(async (tx) => {
  if (values.replace) await tx`TRUNCATE identity_session, identity_membership, identity_organization, identity_user CASCADE`
  const existing = (await tx`SELECT count(*)::int AS count FROM identity_user`)[0].count
  if (existing > 0) throw new Error(`the target already has ${existing} account(s); pass --replace to remove them first`)
  for (const user of users)
    await tx`
      INSERT INTO identity_user (id, employee_id, password_hash, admin, time_created, time_updated)
      VALUES (${user.id}, ${user.employee_id}, ${user.password_hash}, ${user.admin === 1}, ${user.time_created}, ${user.time_updated})`
  for (const item of organizations)
    await tx`
      INSERT INTO identity_organization (id, name, settings_pages, time_created, time_updated)
      VALUES (${item.id}, ${item.name}, ${item.settings_pages}, ${item.time_created}, ${item.time_updated})`
  for (const item of memberships)
    await tx`
      INSERT INTO identity_membership (organization_id, user_id, role, time_created, time_updated)
      VALUES (${item.organization_id}, ${item.user_id}, ${item.role}, ${item.time_created}, ${item.time_updated})`
  for (const item of sessions)
    await tx`
      INSERT INTO identity_session (id, token_hash, user_id, organization_id, expires_at, time_created, time_updated)
      VALUES (${item.id}, ${item.token_hash}, ${item.user_id}, ${item.organization_id}, ${item.expires_at}, ${item.time_created}, ${item.time_updated})`
})
await sql.close()
console.log(
  `migrated ${users.length} users, ${organizations.length} organizations, ${memberships.length} memberships, ${sessions.length} sessions`,
)
