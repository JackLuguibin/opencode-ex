export * as ModelPreference from "./model-preference.js"

import { and, asc, eq, inArray } from "drizzle-orm"
import { Context, Effect, Layer } from "effect"
import { makeGlobalNode } from "@opencode/util/effect/app-node"
import { Credential } from "./credential.js"
import { Database } from "./database/database.js"
import { ModelPreferenceTable } from "./credential/sql.js"

export interface Ref {
  readonly providerID: string
  readonly modelID: string
  readonly variant?: string
}

export interface Preferences {
  /** Models the member chose to hide in pickers. */
  readonly hidden: ReadonlyArray<Ref>
  /** Models the member chose to show although a picker would leave them out by default. */
  readonly shown: ReadonlyArray<Ref>
  readonly favorite: ReadonlyArray<Ref>
  /** Most recently used first. */
  readonly recent: ReadonlyArray<Ref>
  /** The model the member's sessions start on, and fall back to when a session's own is not available to them. */
  readonly default?: Ref
}

export type Patch = {
  readonly [Key in keyof Preferences]?: Preferences[Key] | null
}

export interface Interface {
  /** The acting member's preferences in the current organization; empty without a member. */
  readonly read: (scope?: Credential.Scope) => Effect.Effect<Preferences>
  /** Replaces each kind that is present in the patch, and leaves the others as they are. */
  readonly write: (patch: Patch, scope?: Credential.Scope) => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/ModelPreference") {}

const LISTS = ["hidden", "shown", "favorite", "recent"] as const

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const db = (yield* Database.Service).db
    const credentials = yield* Credential.Service
    const owner = Effect.fnUntraced(function* (scope: Credential.Scope | undefined) {
      const resolved = scope ?? (yield* credentials.scope())
      if (!resolved.userID || resolved.organizationID === null) return
      return { userID: resolved.userID, organizationID: resolved.organizationID }
    })
    return Service.of({
      read: Effect.fn("ModelPreference.read")(function* (scope) {
        const who = yield* owner(scope)
        if (!who) return { hidden: [], shown: [], favorite: [], recent: [] }
        const rows = yield* db
          .select()
          .from(ModelPreferenceTable)
          .where(
            and(
              eq(ModelPreferenceTable.user_id, who.userID),
              eq(ModelPreferenceTable.organization_id, who.organizationID),
            ),
          )
          .orderBy(asc(ModelPreferenceTable.time_created), asc(ModelPreferenceTable.model_id))
          .all()
          .pipe(Effect.orDie)
        const ref = (row: (typeof rows)[number]): Ref => ({
          providerID: row.provider_id,
          modelID: row.model_id,
          ...(row.variant ? { variant: row.variant } : {}),
        })
        const list = (kind: (typeof LISTS)[number]) => rows.filter((row) => row.kind === kind).map(ref)
        const chosen = rows.find((row) => row.kind === "default")
        return {
          hidden: list("hidden"),
          shown: list("shown"),
          favorite: list("favorite"),
          recent: list("recent"),
          ...(chosen ? { default: ref(chosen) } : {}),
        }
      }),
      write: Effect.fn("ModelPreference.write")(function* (patch, scope) {
        const who = yield* owner(scope)
        if (!who) return
        const kinds = [
          ...LISTS.filter((kind) => patch[kind] !== undefined && patch[kind] !== null),
          ...(patch.default !== undefined ? (["default"] as const) : []),
        ]
        if (kinds.length === 0) return
        const now = Date.now()
        yield* db
          .transaction((tx) =>
            Effect.gen(function* () {
              yield* tx
                .delete(ModelPreferenceTable)
                .where(
                  and(
                    eq(ModelPreferenceTable.user_id, who.userID),
                    eq(ModelPreferenceTable.organization_id, who.organizationID),
                    inArray(ModelPreferenceTable.kind, kinds),
                  ),
                )
                .run()
              const rows = [
                ...LISTS.flatMap((kind) =>
                  (patch[kind] ?? []).map((item, index) => ({ kind, item, time: now + index })),
                ),
                ...(patch.default ? [{ kind: "default" as const, item: patch.default, time: now }] : []),
              ]
              // The same model twice in a list would collide on the key; the first one wins.
              const unique = rows.filter(
                (row, index) =>
                  rows.findIndex(
                    (other) =>
                      other.kind === row.kind &&
                      other.item.providerID === row.item.providerID &&
                      other.item.modelID === row.item.modelID,
                  ) === index,
              )
              if (unique.length === 0) return
              yield* tx
                .insert(ModelPreferenceTable)
                .values(
                  unique.map((row) => ({
                    user_id: who.userID,
                    organization_id: who.organizationID,
                    kind: row.kind,
                    provider_id: row.item.providerID,
                    model_id: row.item.modelID,
                    variant: row.item.variant ?? null,
                    time_created: row.time,
                    time_updated: now,
                  })),
                )
                .run()
            }),
          )
          .pipe(Effect.orDie)
      }),
    })
  }),
)

export const node = makeGlobalNode({ service: Service, layer, deps: [Database.node, Credential.node] })
