import { Config } from "@opencode/core/config"
import { Identity } from "@opencode/core/identity"
import { ShellSelect } from "@opencode/core/shell/select"
import { Effect } from "effect"
import { HttpServerRequest } from "effect/http"
import { HttpApiBuilder } from "effect/http-api"
import path from "node:path"
import { accessFor } from "../access"
import { Api } from "../api"
import { ServerAuth } from "../auth"

export const ConfigHandler = HttpApiBuilder.group(Api, "server.config", (handlers) =>
  Effect.gen(function* () {
    const identity = yield* Identity.Service
    const auth = yield* ServerAuth.Config
    return handlers
      .handle(
        "config.get",
        Effect.fn(function* () {
          const entries = yield* Config.Service.use((config) => config.entries())
          const request = yield* HttpServerRequest.HttpServerRequest
          const access = yield* accessFor(request, auth, identity)
          if (access.kind === "operator" || (access.kind === "user" && access.admin)) return entries
          if (access.kind !== "user" || !access.organizationID) return []
          // The server's global config can hold provider keys and MCP credentials, so members only see their organization's.
          const root = yield* identity.organizationRoot(access.organizationID)
          return entries.filter((entry) => {
            if (!entry.path) return false
            const relative = path.relative(root, entry.path)
            return !relative.startsWith("..") && !path.isAbsolute(relative)
          })
        }),
      )
      .handle(
        "config.update",
        Effect.fn(function* (ctx) {
          const config = yield* Config.Service
          if (!config.update) return yield* Effect.die(new Error("Config updates are unavailable"))
          return yield* config.update(ctx.payload).pipe(Effect.orDie)
        }),
      )
      .handle(
        "config.shells",
        Effect.fn(function* () {
          const shell = yield* ShellSelect.Service
          if (!shell.list) return yield* Effect.die(new Error("Shell discovery is unavailable"))
          return yield* shell.list()
        }),
      )
  }),
)
