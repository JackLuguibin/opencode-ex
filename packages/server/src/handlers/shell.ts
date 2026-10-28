import { Identity } from "@opencode/core/identity"
import { Shell } from "@opencode/core/shell"
import { Location } from "@opencode/core/location"
import { Effect } from "effect"
import { HttpServerRequest } from "effect/http"
import { HttpApiBuilder, HttpApiSchema } from "effect/http-api"
import { ShellNotFoundError } from "@opencode/protocol/errors"
import { accessFor } from "../access"
import { Api } from "../api"
import { ServerAuth } from "../auth"
import { requireWorkingDirectory } from "../owned-project"
import { response } from "../location"

export const ShellHandler = HttpApiBuilder.group(Api, "server.shell", (handlers) =>
  Effect.gen(function* () {
    const identity = yield* Identity.Service
    const auth = yield* ServerAuth.Config

    return handlers
      .handle(
        "shell.list",
        Effect.fn(function* () {
          const shell = yield* Shell.Service
          return yield* response(shell.list())
        }),
      )
      .handle(
        "shell.create",
        Effect.fn(function* (ctx) {
          const shell = yield* Shell.Service
          const location = yield* Location.Service
          if (ctx.payload.cwd) {
            const request = yield* HttpServerRequest.HttpServerRequest
            yield* requireWorkingDirectory(ctx.payload.cwd, yield* accessFor(request, auth, identity), identity)
          }
          return yield* response(
            shell.create({ ...ctx.payload, cwd: ctx.payload.cwd || location.directory }).pipe(Effect.orDie),
          )
        }),
      )
      .handle(
        "shell.get",
        Effect.fn(function* (ctx) {
          const shell = yield* Shell.Service
          return yield* response(
            shell
              .get(ctx.params.id)
              .pipe(
                Effect.catchTag(
                  "Shell.NotFoundError",
                  () =>
                    new ShellNotFoundError({ id: ctx.params.id, message: `Shell command not found: ${ctx.params.id}` }),
                ),
              ),
          )
        }),
      )
      .handle(
        "shell.output",
        Effect.fn(function* (ctx) {
          const shell = yield* Shell.Service
          return yield* response(
            shell
              .output(ctx.params.id, { cursor: ctx.query.cursor, limit: ctx.query.limit })
              .pipe(
                Effect.catchTag(
                  "Shell.NotFoundError",
                  () =>
                    new ShellNotFoundError({ id: ctx.params.id, message: `Shell command not found: ${ctx.params.id}` }),
                ),
              ),
          )
        }),
      )
      .handle(
        "shell.remove",
        Effect.fn(function* (ctx) {
          const shell = yield* Shell.Service
          yield* shell.remove(ctx.params.id).pipe(Effect.catchTag("Shell.NotFoundError", () => Effect.void))
          return HttpApiSchema.NoContent.make()
        }),
      )
  }),
)
