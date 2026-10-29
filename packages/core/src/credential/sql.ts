import { integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core"
import { Timestamps } from "../database/schema.sql.js"
import { IdentityOrganizationTable, IdentityUserTable } from "../identity/sql.js"
import type { Credential } from "../credential.js"

export const CredentialTable = sqliteTable("credential", {
  id: text().$type<Credential.ID>().primaryKey(),
  integration_id: text().$type<Credential.Info["integrationID"]>(),
  label: text().notNull(),
  value: text({ mode: "json" }).$type<Credential.Value>().notNull(),
  connector_id: text(),
  method_id: text(),
  active: integer({ mode: "boolean" }),
  // Null marks credentials that predate organizations or belong to the server operator.
  organization_id: text().references(() => IdentityOrganizationTable.id, { onDelete: "cascade" }),
  // Set for a credential only its owner can use; null shares it with the whole organization.
  user_id: text().references(() => IdentityUserTable.id, { onDelete: "cascade" }),
  ...Timestamps,
})

/** An OpenAI-compatible provider an admin defined for one organization. Its API keys are credentials of the same ID. */
export const CustomProviderTable = sqliteTable(
  "custom_provider",
  {
    organization_id: text()
      .notNull()
      .references(() => IdentityOrganizationTable.id, { onDelete: "cascade" }),
    id: text().notNull(),
    name: text().notNull(),
    base_url: text().notNull(),
    models: text({ mode: "json" }).$type<string[]>().notNull(),
    ...Timestamps,
  },
  (table) => [primaryKey({ columns: [table.organization_id, table.id] })],
)

/** An OpenAI-compatible provider one member added for themselves; only that member sees it. */
export const PersonalProviderTable = sqliteTable(
  "personal_provider",
  {
    organization_id: text()
      .notNull()
      .references(() => IdentityOrganizationTable.id, { onDelete: "cascade" }),
    user_id: text()
      .notNull()
      .references(() => IdentityUserTable.id, { onDelete: "cascade" }),
    id: text().notNull(),
    name: text().notNull(),
    base_url: text().notNull(),
    models: text({ mode: "json" }).$type<string[]>().notNull(),
    ...Timestamps,
  },
  (table) => [primaryKey({ columns: [table.organization_id, table.user_id, table.id] })],
)

/** A member's own hidden, favorite and recent models and default model, kept on the server so they follow the account. */
export const ModelPreferenceTable = sqliteTable(
  "model_preference",
  {
    user_id: text()
      .notNull()
      .references(() => IdentityUserTable.id, { onDelete: "cascade" }),
    organization_id: text()
      .notNull()
      .references(() => IdentityOrganizationTable.id, { onDelete: "cascade" }),
    kind: text().$type<"hidden" | "favorite" | "recent" | "default">().notNull(),
    provider_id: text().notNull(),
    model_id: text().notNull(),
    variant: text(),
    ...Timestamps,
  },
  (table) => [primaryKey({ columns: [table.user_id, table.organization_id, table.kind, table.provider_id, table.model_id] })],
)
