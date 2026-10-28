export * as ConfigMcpPlugin from "./mcp.js"

import { define } from "@opencode/plugin/effect/plugin"
import { Document, type Entry } from "@opencode/schema/config"
import type { ServerConfig } from "@opencode/schema/mcp"
import { Effect, Stream } from "effect"
import { Global } from "@opencode/util/global"
import { mkdir } from "node:fs/promises"
import path from "node:path"
import { Config } from "../../config.js"
import { Watcher } from "../../filesystem/watcher.js"
import { Location } from "../../location.js"
import { OrganizationSandbox } from "../../organization-sandbox.js"
import { SharedMcp } from "../../shared-mcp.js"
import { Mcp } from "../../mcp/index.js"

export const Plugin = define({
  id: "opencode.config.mcp",
  effect: Effect.fn(function* (ctx) {
    yield* register(ctx.event.subscribe({ types: ["config.updated"] }))
    yield* registerShared()
  }),
})

/** Adds the MCP servers platform admins opened to this location's organization, and follows changes to that. */
export const registerShared = Effect.fn("ConfigMCPPlugin.registerShared")(function* () {
  const global = yield* Global.Service
  const location = yield* Location.Service
  const organization = OrganizationSandbox.root(global.data, location.directory)
  if (!organization) return
  const organizationID = path.basename(organization)
  const mcp = yield* Mcp.Service
  const watcher = yield* Watcher.Service
  const current = { servers: yield* Effect.promise(() => SharedMcp.readUsable(global.data, organizationID)) }

  yield* mcp.transform((editor) => {
    for (const { name, config } of current.servers) {
      // Servers from the project's own config win over shared ones.
      if (editor.get(name)) continue
      editor.set(name, config)
    }
  })

  yield* Effect.promise(() => mkdir(SharedMcp.stateDirectory(global.data), { recursive: true }))
  const updates = yield* watcher.subscribe({ path: SharedMcp.stateDirectory(global.data), type: "directory" })
  yield* updates.pipe(
    Stream.debounce("100 millis"),
    Stream.runForEach(() =>
      Effect.promise(() => SharedMcp.readUsable(global.data, organizationID)).pipe(
        Effect.tap((servers) => Effect.sync(() => (current.servers = servers))),
        Effect.andThen(mcp.reload()),
      ),
    ),
    Effect.catchCause((cause) => Effect.logError("failed to follow shared MCP servers", { cause })),
    Effect.forkScoped({ startImmediately: true }),
  )
})

export const register = Effect.fn("ConfigMCPPlugin.register")(function* (
  events: Stream.Stream<{ readonly type: string }, unknown>,
) {
  const config = yield* Config.Service
  const mcp = yield* Mcp.Service
  const loaded = { entries: [] as Entry[] }

  yield* events.pipe(
    Stream.filter((event) => event.type === "config.updated"),
    Stream.runForEach(() =>
      config.entries().pipe(
        Effect.tap((entries) => Effect.sync(() => (loaded.entries = entries))),
        Effect.andThen(mcp.reload()),
        Effect.catchCause((cause) => Effect.logError("failed to reload MCP config", { cause })),
      ),
    ),
    Effect.ignore,
    Effect.forkScoped({ startImmediately: true }),
  )

  // Subscribe before the initial load so updates racing it trigger a rebuild.
  loaded.entries = yield* config.entries()
  yield* mcp.transform((editor) => {
    const documents = loaded.entries.filter((entry): entry is Document => entry.type === "document")
    // Global timeout defaults merge in config order; each server can override them.
    const timeout = Object.assign(
      {},
      ...documents.flatMap((entry) => (entry.info.mcp?.timeout ? [entry.info.mcp.timeout] : [])),
    )
    const servers = new Map<string, ServerConfig>()
    for (const document of documents) {
      for (const [name, server] of Object.entries(document.info.mcp?.servers ?? {})) {
        servers.set(name, server)
      }
    }
    for (const [name, server] of servers) {
      if (editor.get(name)) continue
      editor.set(name, { ...server, timeout: { ...timeout, ...server.timeout } })
    }
  })
})
