export * as Credential from "./credential.js"

import { and, asc, desc, eq, isNull, or, sql } from "drizzle-orm"
import { Cause, Context, Effect, Fiber, Layer, Option, Schema } from "effect"
import { Credential } from "@opencode/schema/credential"
import { CredentialLegacy } from "@opencode/schema/credential-legacy"
import { Integration } from "@opencode/schema/integration"
import { Database } from "./database/database.js"
import { Identity } from "./identity.js"
import { Bus } from "./bus.js"
import { makeGlobalNode } from "@opencode/util/effect/app-node"
import { EffectFlock } from "@opencode/util/effect-flock"
import { CredentialTable, CustomProviderTable, PersonalProviderTable } from "./credential/sql.js"
import { Location } from "./location.js"
import { ProjectTable } from "./project/sql.js"
import { ErrorSummary } from "./util/error-summary.js"

export const ID = Credential.ID
export type ID = Credential.ID

export const OAuth = Credential.OAuth
export type OAuth = Credential.OAuth

export const Key = Credential.Key
export type Key = Credential.Key

export const External = Credential.External
export type External = Credential.External

export const Value = Credential.Value
export type Value = Credential.Value

export const Event = Credential.Event

export class Info extends Schema.Class<Info>("Credential.Info")({
  id: ID,
  integrationID: Integration.ID,
  label: Schema.String,
  value: Value,
}) {}

/**
 * The organization whose credentials a call sees; `null` selects the credentials that belong to no organization.
 * Without a scope, listing and creating follow the organization of the current Location's project, and lookups by ID
 * are unrestricted.
 */
export interface Scope {
  readonly organizationID: string | null
  /** The signed-in user, who also sees and manages their own personal credentials. */
  readonly userID?: string
  /** Admins manage the organization's shared credentials; other users manage only their own. Defaults to true without a user. */
  readonly admin?: boolean
  /** Lists only the user's own credentials, for management screens that must not reveal the organization's secrets. */
  readonly ownOnly?: boolean
}

/**
 * Who is acting in the current fiber. Credential listings then include that user's personal credentials on top of the
 * organization's, and the credentials they create are personal unless they are an admin.
 */
export class Actor extends Context.Service<Actor, { readonly userID: string; readonly admin: boolean }>()(
  "@opencode/Credential.Actor",
) {}

export interface Interface {
  /** The scope calls without an explicit one use: the current Location's organization and the acting member. */
  readonly scope: () => Effect.Effect<Scope>
  /** Returns every stored credential in scope. */
  readonly all: (scope?: Scope) => Effect.Effect<Info[]>
  /** Returns stored credentials in scope belonging to one integration. */
  readonly list: (integrationID: Integration.ID, scope?: Scope) => Effect.Effect<Info[]>
  /** Returns one stored credential by ID; with a scope, a credential outside it is not found. */
  readonly get: (id: ID, scope?: Scope) => Effect.Effect<Info | undefined>
  /** Concurrent callers for the same credential share the running operation's result, including failures. */
  readonly lock: (
    id: ID,
    operation: Effect.Effect<OAuth | undefined, unknown>,
  ) => Effect.Effect<OAuth | undefined, unknown>
  /**
   * Creates a credential for an integration and returns the new record. The new credential becomes the
   * integration's selection unless `activate` is false and the integration already has a credential.
   */
  readonly create: (input: {
    readonly id?: ID
    readonly integrationID: Integration.ID
    readonly value: Value
    readonly label?: string
    readonly activate?: boolean
    readonly scope?: Scope
  }) => Effect.Effect<Info>
  /** Selects a stored credential for its integration. */
  readonly activate: (id: ID, scope?: Scope) => Effect.Effect<void>
  /** Updates the label or secret value of a stored credential. */
  readonly update: (id: ID, updates: Partial<Pick<Info, "label" | "value">>, scope?: Scope) => Effect.Effect<void>
  /** Removes a stored credential. */
  readonly remove: (id: ID, scope?: Scope) => Effect.Effect<void>
  /**
   * Which integrations the organization configured (a shared credential or a custom provider it defined) and which the
   * acting member connected themselves. Anything in neither is global: provided by the server's environment or config.
   */
  readonly scopes: (scope?: Scope) => Effect.Effect<{ readonly organization: string[]; readonly personal: string[] }>
  /** The custom providers of the organization in scope, or of the current Location's organization. */
  readonly customProviders: (scope?: Scope) => Effect.Effect<CustomProvider[]>
  /** Creates or replaces an organization's custom provider. */
  readonly saveCustomProvider: (organizationID: string, provider: CustomProvider) => Effect.Effect<void>
  /** Removes an organization's custom provider together with the credentials of every user for it there. */
  readonly removeCustomProvider: (organizationID: string, id: string) => Effect.Effect<void>
  /** The acting member's own providers in the current organization, under the IDs the member chose. */
  readonly personalProviders: (scope?: Scope) => Effect.Effect<CustomProvider[]>
  readonly savePersonalProvider: (organizationID: string, userID: string, provider: CustomProvider) => Effect.Effect<void>
  /** Removes a member's own provider and their credentials for it. */
  readonly removePersonalProvider: (organizationID: string, userID: string, id: string) => Effect.Effect<void>
  /**
   * Every provider the catalog of the current organization defines: the organization's and all members' own. Members
   * only ever see their own because a personal provider is available through its owner's credential alone.
   */
  readonly catalogProviders: () => Effect.Effect<CatalogProvider[]>
}

export interface CustomProvider {
  readonly id: string
  readonly name: string
  readonly baseURL: string
  readonly models: ReadonlyArray<string>
  /** Sent with every request to the provider. */
  readonly headers?: Readonly<Record<string, string>>
  /** Display names by model ID; a model without one is shown by its ID. */
  readonly names?: Readonly<Record<string, string>>
}

/** A provider as the catalog sees it: an organization's, or one member's own under an ID only that member can use. */
export interface CatalogProvider extends CustomProvider {
  readonly scope: "organization" | "personal"
}

const PERSONAL = "personal."

// A user's key that applies in every organization is not a row of this database; it lives in the shared store and is
// shown here under an ID built from its integration.
const GLOBAL = "cred_global."

/** The catalog ID of a member's own provider; it embeds the owner so two members can pick the same name. */
export const personalID = (userID: string, id: string) => `${PERSONAL}${userID}.${id}`

/** The member a provider ID belongs to, or undefined for the organization's and built-in providers. */
export const personalOwner = (providerID: string) =>
  providerID.startsWith(PERSONAL) ? providerID.slice(PERSONAL.length, providerID.indexOf(".", PERSONAL.length)) : undefined

/** Whether `userID` may see the provider or integration `id`: everything except other members' own. */
export const visibleTo = (id: string, userID: string | undefined) => {
  const owner = personalOwner(id)
  return owner === undefined || owner === userID
}

export class Service extends Context.Service<Service, Interface>()("@opencode/Credential") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const db = (yield* Database.Service).db
    const bus = yield* Bus.Service
    const flock = yield* EffectFlock.Service
    const identity = yield* Identity.Service
    const scope = yield* Effect.scope
    const pending = new Map<ID, Fiber.Fiber<OAuth | undefined, unknown>>()
    // Rows written before v2.1 may carry the old key credential shape.
    const decode = Schema.decodeUnknownSync(CredentialLegacy.Value)
    const stored = (row: typeof CredentialTable.$inferSelect) => {
      if (!row.integration_id) return
      return new Info({
        id: row.id,
        integrationID: row.integration_id,
        label: row.label,
        value: decode(row.value),
      })
    }
    const inOrganization = (organizationID: string | null) =>
      organizationID === null
        ? isNull(CredentialTable.organization_id)
        : eq(CredentialTable.organization_id, organizationID)
    // Credentials of one integration compete for selection only within their own organization and owner.
    const siblings = (integrationID: Integration.ID, organizationID: string | null, userID: string | null) =>
      and(
        eq(CredentialTable.integration_id, integrationID),
        inOrganization(organizationID),
        userID === null ? isNull(CredentialTable.user_id) : eq(CredentialTable.user_id, userID),
      )
    type Resolved = {
      readonly organizationID: string | null
      readonly userID?: string
      readonly admin: boolean
      readonly ownOnly?: boolean
    }
    const explicit = (scope: Scope): Resolved => ({
      organizationID: scope.organizationID,
      userID: scope.userID,
      admin: scope.admin ?? scope.userID === undefined,
      ownOnly: scope.ownOnly,
    })
    // Shared credentials plus the acting user's own.
    const visible = (scope: Resolved) =>
      and(
        inOrganization(scope.organizationID),
        scope.userID
          ? scope.ownOnly
            ? eq(CredentialTable.user_id, scope.userID)
            : or(isNull(CredentialTable.user_id), eq(CredentialTable.user_id, scope.userID))
          : isNull(CredentialTable.user_id),
      )
    // Own credentials, and the shared ones when the actor is an admin.
    const manageable = (scope: Resolved) =>
      and(
        inOrganization(scope.organizationID),
        scope.userID
          ? or(eq(CredentialTable.user_id, scope.userID), scope.admin ? isNull(CredentialTable.user_id) : undefined)
          : isNull(CredentialTable.user_id),
      )
    const byID = (id: ID, scope: Scope | undefined, access: typeof visible) =>
      scope ? and(eq(CredentialTable.id, id), access(explicit(scope))) : eq(CredentialTable.id, id)
    const resolveScope = Effect.fnUntraced(function* (scope: Scope | undefined) {
      if (scope) return explicit(scope)
      const actor = Option.getOrUndefined(yield* Effect.serviceOption(Actor))
      const location = yield* Effect.serviceOption(Location.Service)
      const row = Option.isNone(location)
        ? undefined
        : yield* db
            .select({ organization_id: ProjectTable.organization_id })
            .from(ProjectTable)
            .where(eq(ProjectTable.id, location.value.project.id))
            .get()
            .pipe(Effect.orDie)
      return {
        organizationID: row?.organization_id ?? null,
        userID: actor?.userID,
        admin: actor?.admin ?? true,
      } satisfies Resolved
    })
    // A user's own credentials win over the organization's, so they are listed last like the selected one.
    const personalLast = sql`${CredentialTable.user_id} is not null`
    const storedRows = (rows: ReadonlyArray<typeof CredentialTable.$inferSelect>) =>
      rows.flatMap((row) => {
        const credential = stored(row)
        return credential ? [credential] : []
      })

    // The signed-in user's keys for every organization. Management screens (`ownOnly`) and the operator's scope without
    // an organization do not see them.
    const globalKeys = (scope: Resolved) =>
      scope.userID === undefined || scope.ownOnly || scope.organizationID === null
        ? Effect.succeed([])
        : identity.userKeys(scope.userID).pipe(
            Effect.map((keys) =>
              keys.map(
                (item) =>
                  new Info({
                    id: ID.make(GLOBAL + item.integrationID),
                    integrationID: Integration.ID.make(item.integrationID),
                    label: "All organizations",
                    value: Key.make({ type: "key", key: item.key }),
                  }),
              ),
            ),
          )
    // Later entries win: the organization's shared keys, then the user's own for every organization, then the user's
    // own for this organization.
    const layered = (rows: ReadonlyArray<typeof CredentialTable.$inferSelect>, global: ReadonlyArray<Info>) => [
      ...storedRows(rows.filter((row) => row.user_id === null)),
      ...global,
      ...storedRows(rows.filter((row) => row.user_id !== null)),
    ]

    const provider = (row: {
      id: string
      name: string
      base_url: string
      models: string[]
      headers: Record<string, string> | null
      model_names: Record<string, string> | null
    }): CustomProvider => ({
      id: row.id,
      name: row.name,
      baseURL: row.base_url,
      models: row.models,
      ...(row.headers && Object.keys(row.headers).length > 0 ? { headers: row.headers } : {}),
      ...(row.model_names && Object.keys(row.model_names).length > 0 ? { names: row.model_names } : {}),
    })
    const customProviders = Effect.fn("Credential.customProviders")(function* (scope?: Scope) {
      const resolved = yield* resolveScope(scope)
      if (resolved.organizationID === null) return []
      const rows = yield* db
        .select()
        .from(CustomProviderTable)
        .where(eq(CustomProviderTable.organization_id, resolved.organizationID))
        .orderBy(asc(CustomProviderTable.name), asc(CustomProviderTable.id))
        .all()
        .pipe(Effect.orDie)
      return rows.map(provider)
    })

    const personalProviders = Effect.fn("Credential.personalProviders")(function* (scope?: Scope) {
      const resolved = yield* resolveScope(scope)
      if (resolved.organizationID === null || !resolved.userID) return []
      const rows = yield* db
        .select()
        .from(PersonalProviderTable)
        .where(
          and(
            eq(PersonalProviderTable.organization_id, resolved.organizationID),
            eq(PersonalProviderTable.user_id, resolved.userID),
          ),
        )
        .orderBy(asc(PersonalProviderTable.name), asc(PersonalProviderTable.id))
        .all()
        .pipe(Effect.orDie)
      return rows.map(provider)
    })

    const scopes = Effect.fn("Credential.scopes")(function* (scope?: Scope) {
      const resolved = yield* resolveScope(scope)
      if (resolved.organizationID === null) return { organization: [], personal: [] }
      const rows = yield* db
        .select({ integration_id: CredentialTable.integration_id, user_id: CredentialTable.user_id })
        .from(CredentialTable)
        .where(visible({ ...resolved, ownOnly: false }))
        .all()
        .pipe(Effect.orDie)
      const providers = yield* customProviders(scope)
      const mine = yield* personalProviders(scope)
      const ids = (personal: boolean) => rows.flatMap((row) => (row.integration_id && (row.user_id !== null) === personal ? [row.integration_id] : []))
      return {
        organization: [...new Set([...ids(false), ...providers.map((item) => item.id)])],
        personal: [
          ...new Set([
            ...ids(true),
            ...(resolved.userID ? mine.map((item) => personalID(resolved.userID!, item.id)) : []),
          ]),
        ],
      }
    })

    return Service.of({
      scopes,
      scope: Effect.fn("Credential.scope")(function* () {
        const resolved = yield* resolveScope(undefined)
        return { organizationID: resolved.organizationID, userID: resolved.userID, admin: resolved.admin } satisfies Scope
      }),
      customProviders,
      personalProviders,
      savePersonalProvider: Effect.fn("Credential.savePersonalProvider")(function* (organizationID, userID, provider) {
        const now = Date.now()
        const values = {
          name: provider.name,
          base_url: provider.baseURL,
          models: [...provider.models],
          headers: provider.headers ? { ...provider.headers } : null,
          model_names: provider.names ? { ...provider.names } : null,
          time_updated: now,
        }
        yield* db
          .insert(PersonalProviderTable)
          .values({ organization_id: organizationID, user_id: userID, id: provider.id, ...values, time_created: now })
          .onConflictDoUpdate({
            target: [PersonalProviderTable.organization_id, PersonalProviderTable.user_id, PersonalProviderTable.id],
            set: values,
          })
          .run()
          .pipe(Effect.orDie)
        yield* bus.publish(Event.Updated, {}, { global: true })
      }),
      removePersonalProvider: Effect.fn("Credential.removePersonalProvider")(function* (organizationID, userID, id) {
        yield* db
          .transaction((tx) =>
            Effect.gen(function* () {
              yield* tx
                .delete(PersonalProviderTable)
                .where(
                  and(
                    eq(PersonalProviderTable.organization_id, organizationID),
                    eq(PersonalProviderTable.user_id, userID),
                    eq(PersonalProviderTable.id, id),
                  ),
                )
                .run()
              yield* tx
                .delete(CredentialTable)
                .where(
                  and(
                    eq(CredentialTable.organization_id, organizationID),
                    eq(CredentialTable.user_id, userID),
                    eq(CredentialTable.integration_id, Integration.ID.make(personalID(userID, id))),
                  ),
                )
                .run()
            }),
          )
          .pipe(Effect.orDie)
        yield* bus.publish(Event.Updated, {}, { global: true })
      }),
      catalogProviders: Effect.fn("Credential.catalogProviders")(function* () {
        const resolved = yield* resolveScope(undefined)
        const organization = yield* customProviders()
        if (resolved.organizationID === null) return []
        const personal = yield* db
          .select()
          .from(PersonalProviderTable)
          .where(eq(PersonalProviderTable.organization_id, resolved.organizationID))
          .orderBy(asc(PersonalProviderTable.name), asc(PersonalProviderTable.id))
          .all()
          .pipe(Effect.orDie)
        return [
          ...organization.map((provider): CatalogProvider => ({ ...provider, scope: "organization" })),
          ...personal.map(
            (row): CatalogProvider => ({ ...provider(row), id: personalID(row.user_id, row.id), scope: "personal" }),
          ),
        ]
      }),
      saveCustomProvider: Effect.fn("Credential.saveCustomProvider")(function* (organizationID, provider) {
        const now = Date.now()
        const values = {
          name: provider.name,
          base_url: provider.baseURL,
          models: [...provider.models],
          headers: provider.headers ? { ...provider.headers } : null,
          model_names: provider.names ? { ...provider.names } : null,
          time_updated: now,
        }
        yield* db
          .insert(CustomProviderTable)
          .values({ organization_id: organizationID, id: provider.id, ...values, time_created: now })
          .onConflictDoUpdate({ target: [CustomProviderTable.organization_id, CustomProviderTable.id], set: values })
          .run()
          .pipe(Effect.orDie)
        // Locations rebuild their catalogs on credential changes, which covers provider definitions too.
        yield* bus.publish(Event.Updated, {}, { global: true })
      }),
      removeCustomProvider: Effect.fn("Credential.removeCustomProvider")(function* (organizationID, id) {
        yield* db
          .transaction((tx) =>
            Effect.gen(function* () {
              yield* tx
                .delete(CustomProviderTable)
                .where(and(eq(CustomProviderTable.organization_id, organizationID), eq(CustomProviderTable.id, id)))
                .run()
              yield* tx
                .delete(CredentialTable)
                .where(
                  and(
                    eq(CredentialTable.organization_id, organizationID),
                    eq(CredentialTable.integration_id, Integration.ID.make(id)),
                  ),
                )
                .run()
            }),
          )
          .pipe(Effect.orDie)
        yield* bus.publish(Event.Updated, {}, { global: true })
      }),
      lock: Effect.fn("Credential.lock")((id, operation) =>
        Effect.uninterruptibleMask((restore) =>
          Effect.gen(function* () {
            const current = pending.get(id)
            if (current) return yield* restore(Fiber.join(current))
            // The global scope owns the operation, not the first Session or Location waiting for it.
            // The file lock extends this to other processes sharing the database.
            const fiber = yield* operation.pipe(
              flock.withLock(`credential-refresh:${id}`),
              Effect.ensuring(Effect.sync(() => pending.delete(id))),
              Effect.forkIn(scope),
            )
            pending.set(id, fiber)
            return yield* restore(Fiber.join(fiber))
          }),
        ),
      ),
      all: Effect.fn("Credential.all")(function* (scope) {
        const resolved = yield* resolveScope(scope)
        return yield* db
          .select()
          .from(CredentialTable)
          .where(visible(resolved))
          .orderBy(asc(personalLast), asc(CredentialTable.active), asc(CredentialTable.time_created), asc(CredentialTable.id))
          .all()
          .pipe(
            Effect.orDie,
            Effect.flatMap((rows) => Effect.map(globalKeys(resolved), (global) => layered(rows, global))),
          )
      }),
      list: Effect.fn("Credential.list")(function* (integrationID, scope) {
        const resolved = yield* resolveScope(scope)
        return yield* db
          .select()
          .from(CredentialTable)
          .where(and(eq(CredentialTable.integration_id, integrationID), visible(resolved)))
          .orderBy(asc(personalLast), asc(CredentialTable.active), asc(CredentialTable.time_created), asc(CredentialTable.id))
          .all()
          .pipe(
            Effect.orDie,
            Effect.flatMap((rows) =>
              Effect.map(globalKeys(resolved), (global) =>
                layered(
                  rows,
                  global.filter((credential) => credential.integrationID === integrationID),
                ),
              ),
            ),
          )
      }),
      get: Effect.fn("Credential.get")(function* (id, scope) {
        if (id.startsWith(GLOBAL)) return (yield* globalKeys(yield* resolveScope(scope))).find((item) => item.id === id)
        const row = yield* db.select().from(CredentialTable).where(byID(id, scope, visible)).get().pipe(Effect.orDie)
        return row ? stored(row) : undefined
      }),
      create: Effect.fn("Credential.create")(function* (input) {
        const credential = new Info({
          id: input.id ?? ID.create(),
          integrationID: input.integrationID,
          label: input.label ?? "default",
          value: input.value,
        })
        const resolved = yield* resolveScope(input.scope)
        const organizationID = resolved.organizationID
        // Admins configure the organization's credentials; everyone else adds their own.
        const ownerID = resolved.admin ? null : (resolved.userID ?? null)
        const activated = yield* db
          .transaction((tx) =>
            Effect.gen(function* () {
              const current = yield* tx
                .select({ id: CredentialTable.id, active: CredentialTable.active })
                .from(CredentialTable)
                .where(siblings(credential.integrationID, organizationID, ownerID))
                .orderBy(desc(CredentialTable.active), desc(CredentialTable.time_created), desc(CredentialTable.id))
                .get()
              const activate = input.activate !== false || !current
              if (activate)
                yield* tx
                  .update(CredentialTable)
                  .set({ active: false })
                  .where(siblings(credential.integrationID, organizationID, ownerID))
                  .run()
              // Legacy rows have no active flag and the newest one is selected, so pin it before inserting a newer row.
              if (!activate && current && !current.active)
                yield* tx.update(CredentialTable).set({ active: true }).where(eq(CredentialTable.id, current.id)).run()
              yield* tx
                .insert(CredentialTable)
                .values({
                  id: credential.id,
                  integration_id: credential.integrationID,
                  label: credential.label,
                  value: credential.value,
                  active: activate,
                  organization_id: organizationID,
                  user_id: ownerID,
                })
                .run()
              return activate
            }),
          )
          .pipe(
            Effect.onError((cause) =>
              Effect.logError("credential create failed", {
                credentialID: credential.id,
                integrationID: credential.integrationID,
                errors: ErrorSummary.from(Cause.squash(cause)),
              }),
            ),
            Effect.orDie,
          )
        yield* Effect.logInfo("credential created", {
          credentialID: credential.id,
          integrationID: credential.integrationID,
          type: credential.value.type,
          active: activated,
        })
        yield* bus.publish(Event.Updated, {}, { global: true })
        if (activated)
          yield* bus.publish(
            Event.Switched,
            { integrationID: credential.integrationID, credentialID: credential.id },
            { global: true },
          )
        return credential
      }),
      activate: Effect.fn("Credential.activate")(function* (id, scope) {
        const integrationID = yield* db
          .transaction((tx) =>
            Effect.gen(function* () {
              const credential = yield* tx.select().from(CredentialTable).where(byID(id, scope, manageable)).get()
              if (!credential?.integration_id) return
              const active = yield* tx
                .select({ id: CredentialTable.id })
                .from(CredentialTable)
                .where(siblings(credential.integration_id, credential.organization_id, credential.user_id))
                .orderBy(desc(CredentialTable.active), desc(CredentialTable.time_created), desc(CredentialTable.id))
                .get()
              if (active?.id === id) return
              yield* tx
                .update(CredentialTable)
                .set({ active: false })
                .where(siblings(credential.integration_id, credential.organization_id, credential.user_id))
                .run()
              yield* tx.update(CredentialTable).set({ active: true }).where(eq(CredentialTable.id, id)).run()
              return credential.integration_id
            }),
          )
          .pipe(
            Effect.onError((cause) =>
              Effect.logError("credential activate failed", {
                credentialID: id,
                errors: ErrorSummary.from(Cause.squash(cause)),
              }),
            ),
            Effect.orDie,
          )
        if (integrationID) {
          yield* Effect.logInfo("credential activated", { integrationID, credentialID: id })
          yield* bus.publish(Event.Switched, { integrationID, credentialID: id }, { global: true })
        }
      }),
      update: Effect.fn("Credential.update")(function* (id, updates, scope) {
        if (updates.label === undefined && updates.value === undefined) return
        const credential = yield* db
          .select({ integrationID: CredentialTable.integration_id, label: CredentialTable.label })
          .from(CredentialTable)
          .where(byID(id, scope, manageable))
          .get()
          .pipe(
            Effect.onError((cause) =>
              Effect.logError("credential update lookup failed", {
                credentialID: id,
                errors: ErrorSummary.from(Cause.squash(cause)),
              }),
            ),
            Effect.orDie,
          )
        if (!credential?.integrationID) {
          yield* Effect.logWarning("credential update skipped", { credentialID: id, reason: "credential_missing" })
          return
        }
        if (updates.label === credential.label && updates.value === undefined) return
        const updated = yield* db
          .update(CredentialTable)
          .set({ label: updates.label, value: updates.value })
          .where(byID(id, scope, manageable))
          .returning({ id: CredentialTable.id })
          .get()
          .pipe(
            Effect.onError((cause) =>
              Effect.logError("credential update failed", {
                credentialID: id,
                integrationID: credential.integrationID,
                errors: ErrorSummary.from(Cause.squash(cause)),
              }),
            ),
            Effect.orDie,
          )
        if (!updated) {
          yield* Effect.logWarning("credential update skipped", { credentialID: id, reason: "credential_removed" })
          return
        }
        yield* Effect.logInfo("credential updated", {
          credentialID: id,
          integrationID: credential.integrationID,
          valueChanged: updates.value !== undefined,
          labelChanged: updates.label !== undefined && updates.label !== credential.label,
        })
        if (updates.label !== undefined && updates.label !== credential.label)
          yield* bus.publish(Event.Updated, {}, { global: true })
      }),
      remove: Effect.fn("Credential.remove")(function* (id, scope) {
        const removed = yield* db
          .transaction((tx) =>
            Effect.gen(function* () {
              const credential = yield* tx.select().from(CredentialTable).where(byID(id, scope, manageable)).get()
              if (!credential) return
              const active = credential.integration_id
                ? yield* tx
                    .select({ id: CredentialTable.id })
                    .from(CredentialTable)
                    .where(siblings(credential.integration_id, credential.organization_id, credential.user_id))
                    .orderBy(desc(CredentialTable.active), desc(CredentialTable.time_created), desc(CredentialTable.id))
                    .get()
                : undefined
              yield* tx.delete(CredentialTable).where(eq(CredentialTable.id, id)).run()
              if (!credential.integration_id || active?.id !== id)
                return { switched: false as const, integrationID: credential.integration_id }
              const replacement = yield* tx
                .select({ id: CredentialTable.id })
                .from(CredentialTable)
                .where(siblings(credential.integration_id, credential.organization_id, credential.user_id))
                .orderBy(desc(CredentialTable.time_created), desc(CredentialTable.id))
                .get()
              if (replacement) {
                yield* tx
                  .update(CredentialTable)
                  .set({ active: false })
                  .where(siblings(credential.integration_id, credential.organization_id, credential.user_id))
                  .run()
                yield* tx
                  .update(CredentialTable)
                  .set({ active: true })
                  .where(eq(CredentialTable.id, replacement.id))
                  .run()
              }
              return {
                switched: true as const,
                integrationID: credential.integration_id,
                credentialID: replacement?.id ?? null,
              }
            }),
          )
          .pipe(
            Effect.onError((cause) =>
              Effect.logError("credential remove failed", {
                credentialID: id,
                errors: ErrorSummary.from(Cause.squash(cause)),
              }),
            ),
            Effect.orDie,
          )
        if (!removed) return
        yield* Effect.logInfo("credential removed", {
          credentialID: id,
          integrationID: removed.integrationID,
          active: removed.switched,
          ...(removed.switched ? { replacementID: removed.credentialID } : {}),
        })
        yield* bus.publish(Event.Updated, {}, { global: true })
        if (removed.switched)
          yield* bus.publish(
            Event.Switched,
            { integrationID: removed.integrationID, credentialID: removed.credentialID },
            { global: true },
          )
      }),
    })
  }),
)

export const node = makeGlobalNode({ service: Service, layer, deps: [Database.node, Bus.node, EffectFlock.node, Identity.node] })
