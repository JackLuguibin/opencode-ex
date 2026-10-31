import { Database } from "@opencode/core/database/database"
import { ModelsDev } from "@opencode/core/models-dev"
import { PersistentPty } from "@opencode/core/persistent-pty"
import { Schema } from "effect"

export const ServerOptions = Schema.Struct({
  app: Schema.optional(
    Schema.Struct({
      name: Schema.optional(Schema.String),
      version: Schema.optional(Schema.String),
      channel: Schema.optional(Schema.String),
    }),
  ),
  hostname: Schema.optional(Schema.String),
  port: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0), Schema.isLessThanOrEqualTo(65_535))),
  password: Schema.optional(Schema.String),
  gatewaySecret: Schema.optional(Schema.String),
  /** Further keys accepted for gateway headers while the signing key is being rotated. */
  gatewaySecretExtra: Schema.optional(Schema.Array(Schema.String)),
  /** An organization id or name a sign-in without one joins; absent leaves such accounts where they are. */
  defaultOrganization: Schema.optional(Schema.String),
  /** Whether the login screen can start a guest account, which lands in `defaultOrganization`. */
  guest: Schema.optional(Schema.Boolean),
  /** UAC SSO login: when set, users can sign in with their corporate account. */
  uac: Schema.optional(
    Schema.Struct({
      credentialURL: Schema.String,
      uri: Schema.String,
      tenant: Schema.String,
      appId: Schema.String,
    }),
  ),
  /** Announces this execution layer to the Auth server's scheduler through Redis. */
  registry: Schema.optional(
    Schema.Struct({
      redis: Schema.String,
      /** Where the Auth server reaches this process. */
      advertise: Schema.String,
      id: Schema.optional(Schema.String),
      /** How long shutdown waits for running sessions to finish before interrupting them. */
      drainTimeoutMs: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
    }),
  ),
  cors: Schema.optional(Schema.Array(Schema.String)),
  simulation: Schema.optional(Schema.Boolean),
  database: Schema.optional(Database.Options),
  pty: Schema.optional(PersistentPty.Options),
  events: Schema.optional(
    Schema.Struct({
      persist: Schema.optional(Schema.Boolean),
    }),
  ),
  models: Schema.optional(ModelsDev.Options),
  config: Schema.optional(
    Schema.Struct({
      directory: Schema.optional(Schema.String),
      project: Schema.optional(Schema.Boolean),
      claude: Schema.optional(Schema.Boolean),
      file: Schema.optional(Schema.String),
      content: Schema.optional(Schema.String),
    }),
  ),
  windows: Schema.optional(
    Schema.Struct({
      gitbash: Schema.optional(Schema.String),
    }),
  ),
  fs: Schema.optional(
    Schema.Struct({
      filewatcher: Schema.optional(Schema.Boolean),
      fff: Schema.optional(Schema.Boolean),
    }),
  ),
})
export type ServerOptions = typeof ServerOptions.Type
