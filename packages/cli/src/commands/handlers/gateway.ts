import { Effect, FileSystem } from "effect"
import { Commands } from "../commands"
import { Runtime } from "../../framework/runtime"
import { load } from "../../app-assets"
import { WebUi } from "../../services/web-ui"

export default Runtime.handler(
  Commands.commands.gateway,
  Effect.fnUntraced(function* () {
    const { start } = yield* Effect.promise(() => import("@opencode/auth/start"))
    // The gateway serves the web app from this binary too, so a deployment needs no separate web server.
    const fileSystem = yield* FileSystem.FileSystem
    const assets = yield* load().pipe(Effect.provideService(FileSystem.FileSystem, fileSystem))
    yield* Effect.promise(() => start({ ui: (request) => WebUi.response(request, assets.files, assets.brotli) }))
    // The gateway's server keeps the process alive.
    return yield* Effect.never
  }),
)
