import { integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core"
import { Timestamps } from "../database/schema.sql.js"

export const IdentityUserTable = sqliteTable("identity_user", {
  id: text().primaryKey(),
  employee_id: text().notNull().unique(),
  password_hash: text().notNull(),
  admin: integer({ mode: "boolean" }).notNull(),
  ...Timestamps,
})

export const IdentityOrganizationTable = sqliteTable("identity_organization", {
  id: text().primaryKey(),
  name: text().notNull(),
  // Settings pages ordinary members can open; null keeps the defaults.
  settings_pages: text({ mode: "json" }).$type<string[]>(),
  ...Timestamps,
})

export const IdentityMembershipTable = sqliteTable(
  "identity_membership",
  {
    organization_id: text()
      .notNull()
      .references(() => IdentityOrganizationTable.id, { onDelete: "cascade" }),
    user_id: text()
      .notNull()
      .references(() => IdentityUserTable.id, { onDelete: "cascade" }),
    // Organization admins manage their own organization; platform admins are set on the user.
    role: text().$type<"admin" | "member">().notNull().default("member"),
    ...Timestamps,
  },
  (table) => [primaryKey({ columns: [table.organization_id, table.user_id] })],
)

export const IdentitySessionTable = sqliteTable("identity_session", {
  id: text().primaryKey(),
  token_hash: text().notNull().unique(),
  user_id: text()
    .notNull()
    .references(() => IdentityUserTable.id, { onDelete: "cascade" }),
  organization_id: text().references(() => IdentityOrganizationTable.id, { onDelete: "set null" }),
  expires_at: integer().notNull(),
  ...Timestamps,
})

/**
 * Per-user client state kept on the server so it follows the account to any browser. An empty `organization_id` is the
 * user's own state; otherwise it belongs to that organization's view. Values are opaque JSON the client owns.
 */
export const IdentityPreferenceTable = sqliteTable(
  "identity_preference",
  {
    user_id: text()
      .notNull()
      .references(() => IdentityUserTable.id, { onDelete: "cascade" }),
    organization_id: text().notNull(),
    key: text().notNull(),
    value: text().notNull(),
    ...Timestamps,
  },
  (table) => [primaryKey({ columns: [table.user_id, table.organization_id, table.key] })],
)
