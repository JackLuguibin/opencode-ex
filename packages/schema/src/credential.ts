export * as Credential from "./credential.js"

import { Schema } from "effect"
import { optional } from "./schema.js"
import { ephemeral, inventory } from "./event.js"
import { IntegrationID, IntegrationMethodID } from "./integration-id.js"
import { ascending } from "./identifier.js"
import { NonNegativeInt, statics } from "./schema.js"

export const ID = Schema.String.pipe(
  Schema.brand("Credential.ID"),
  Schema.annotate({ identifier: "Credential.ID" }),
  statics((schema) => ({ create: () => schema.make("cred_" + ascending()) })),
)
export type ID = typeof ID.Type

const Updated = ephemeral({
  type: "credential.updated",
  schema: {},
})
const Switched = ephemeral({
  type: "credential.switched",
  schema: { integrationID: IntegrationID, credentialID: Schema.NullOr(ID) },
})
export const Event = {
  Updated,
  Switched,
  Definitions: inventory(Updated, Switched),
}

export interface OAuth extends Schema.Schema.Type<typeof OAuth> {}
export const OAuth = Schema.Struct({
  type: Schema.Literal("oauth"),
  methodID: IntegrationMethodID,
  refresh: Schema.String,
  access: Schema.String,
  expires: NonNegativeInt,
  metadata: optional(Schema.Record(Schema.String, Schema.Unknown)),
}).annotate({ identifier: "Credential.OAuth" })

export interface Key extends Schema.Schema.Type<typeof Key> {}
export const Key = Schema.Struct({
  type: Schema.Literal("key"),
  key: Schema.String,
  metadata: optional(Schema.Record(Schema.String, Schema.Unknown)),
}).annotate({ identifier: "Credential.Key" })

/** References a credential source whose secrets and renewal are managed outside the credential store. */
export interface External extends Schema.Schema.Type<typeof External> {}
export const External = Schema.Struct({
  type: Schema.Literal("external"),
  methodID: IntegrationMethodID,
  metadata: optional(Schema.Record(Schema.String, Schema.Unknown)),
}).annotate({ identifier: "Credential.External" })

export const Value = Schema.Union([OAuth, Key, External])
  .pipe(Schema.toTaggedUnion("type"))
  .annotate({ identifier: "Credential.Value" })
export type Value = Schema.Schema.Type<typeof Value>

/** Whose a credential or provider is: the whole organization's, or only its owner's. */
export const Scope = Schema.Literals(["organization", "personal"]).annotate({ identifier: "Credential.Scope" })
export type Scope = typeof Scope.Type

export interface Entry extends Schema.Schema.Type<typeof Entry> {}
export const Entry = Schema.Struct({
  id: ID,
  integrationID: IntegrationID,
  label: Schema.String,
  active: Schema.Boolean,
  value: Value,
  scope: Scope,
}).annotate({ identifier: "Credential.Entry" })

export interface CreateInput extends Schema.Schema.Type<typeof CreateInput> {}
export const CreateInput = Schema.Struct({
  id: optional(ID),
  integrationID: IntegrationID,
  label: optional(Schema.String),
  value: Value,
  activate: optional(Schema.Boolean),
  /** Defaults to personal. Only an organization admin can store a credential for the whole organization. */
  scope: optional(Scope),
}).annotate({ identifier: "Credential.CreateInput" })

/** An OpenAI-compatible provider a member added for themselves. */
export interface PersonalProvider extends Schema.Schema.Type<typeof PersonalProvider> {}
export const PersonalProvider = Schema.Struct({
  /** The ID the member chose. */
  id: Schema.String,
  /** The ID the provider has in the catalog and in model references. */
  providerID: Schema.String,
  name: Schema.String,
  baseURL: Schema.String,
  models: Schema.Array(Schema.String),
}).annotate({ identifier: "Credential.PersonalProvider" })

export interface PersonalProviderInput extends Schema.Schema.Type<typeof PersonalProviderInput> {}
export const PersonalProviderInput = Schema.Struct({
  name: Schema.String,
  baseURL: Schema.String,
  models: Schema.Array(Schema.String),
  /** Stored as the member's own key for the provider. */
  key: optional(Schema.String),
}).annotate({ identifier: "Credential.PersonalProviderInput" })
