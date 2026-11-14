export * as ConfigPolicyPlugin from "./policy.js"

import { define } from "@opencode/plugin/effect/plugin"
import { Effect, Option, Stream } from "effect"
import { Config } from "../../config.js"
import { Credential } from "../../credential.js"
import { ManagedPolicy } from "../../managed-policy.js"
import { State } from "../../state.js"
import { Wildcard } from "../../util/wildcard.js"
import { ConfigEntryObserver } from "./entry-observer.js"

export const Plugin = define({
  id: "opencode.config.policy",
  effect: Effect.fn(function* (ctx) {
    const config = yield* Config.Service
    const managed = yield* ManagedPolicy.Service
    const reload = State.batch(
      Effect.all([ctx.provider.reload(), ctx.mcp.reload(), ctx.skill.reload()], { discard: true }),
    )
    const loaded = yield* ConfigEntryObserver.observe(config, ctx.event, reload)
    yield* managed.changes().pipe(
      Stream.runForEach(() => reload),
      Effect.forkScoped({ startImmediately: true }),
    )
    // Documents reverse so earlier-loaded policy wins: managed policy, then a Console config document, then user
    // and project files. Statements from a Console serving the legacy format follow every document and have the
    // final say.
    const policies = () => ManagedPolicy.statements(loaded.entries, managed.current())
    const runSync = Effect.runSyncWith(yield* Effect.context())
    // Providers an admin defined for the organization or for every organization. A blanket `*` deny is meant for the
    // built-in catalog, so it does not hide these; a rule that names one (or a pattern other than `*`) still does.
    const credentials = Option.getOrUndefined(yield* Effect.serviceOption(Credential.Service))
    const shared = { ids: new Set<string>() }
    const loadShared = credentials
      ? credentials.catalogProviders().pipe(
          Effect.map(
            (providers) => new Set(providers.filter((item) => item.scope !== "personal").map((item) => item.id)),
          ),
          Effect.tap((ids) => Effect.sync(() => (shared.ids = ids))),
        )
      : Effect.void
    yield* ctx.event.subscribe({ types: ["credential.updated"] }).pipe(
      Stream.runForEach(() => loadShared.pipe(Effect.andThen(ctx.provider.reload()))),
      Effect.forkScoped({ startImmediately: true }),
    )
    yield* loadShared
    yield* ctx.provider.transform((providers) => {
      const current = policies()
      const denied: string[] = []
      for (const record of providers.list()) {
        const policy = current.findLast(
          (policy) =>
            policy.action === "provider.use" &&
            Wildcard.match(record.provider.id, policy.resource) &&
            !(policy.resource === "*" && shared.ids.has(record.provider.id)),
        )
        if (policy?.effect !== "deny") continue
        providers.remove(record.provider.id)
        // Skip unconfigured catalog entries; deny-all policies would otherwise log the whole catalog.
        if (record.provider.activation === "enabled") denied.push(record.provider.id)
      }
      if (denied.length) runSync(Effect.logDebug("providers denied by policy", { providers: denied }))
    })
    yield* ctx.mcp.transform((servers) => {
      const current = policies()
      for (const [name] of servers.list()) {
        if (ManagedPolicy.decision(current, "integration.use", `mcp:${name}`) === "deny") servers.remove(name)
      }
    })
    yield* ctx.skill.transform((skills) => {
      const current = policies()
      for (const skill of skills.list()) {
        if (ManagedPolicy.decision(current, "integration.use", `skill:${skill.id}`) === "deny") skills.remove(skill.id)
      }
    })
    yield* ctx.permission.hook("evaluate", (event) =>
      Effect.sync(() => {
        const current = policies()
        const denied = event.resources
          .map((resource) =>
            current.findLast(
              (policy) =>
                policy.action === "tool.use" && Wildcard.match(`${event.action}:${resource}`, policy.resource),
            ),
          )
          .find((policy) => policy?.effect === "deny")
        if (!denied) return
        event.effect = "deny"
        event.message = denied.message
      }),
    )
  }),
})
