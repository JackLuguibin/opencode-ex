import { Effect } from "effect"
import { Commands } from "../commands"
import { Runtime } from "../../framework/runtime"
import { OPENCODE_VERSION } from "../../version"

export default Runtime.handler(
  Commands.commands.knowledge,
  Effect.fnUntraced(function* () {
    const { KnowledgeStart } = yield* Effect.promise(() => import("@opencode/knowledge/start"))
    const secret = process.env.OPENCODE_KNOWLEDGE_SECRET
    if (!secret) {
      console.error("OPENCODE_KNOWLEDGE_SECRET is required: execution layers sign every call to this service with it")
      process.exit(1)
    }
    // One address to listen on, e.g. http://0.0.0.0:4200.
    const listen = new URL(process.env.OPENCODE_KNOWLEDGE_URL ?? "http://127.0.0.1:4200")
    const running = yield* Effect.promise(() =>
      KnowledgeStart.start({
        data: process.env.OPENCODE_KNOWLEDGE_DATA ?? "./knowledge",
        hostname: listen.hostname,
        port: Number(listen.port || 4200),
        advertise: process.env.OPENCODE_KNOWLEDGE_ADVERTISE_URL,
        secrets: [secret, ...(process.env.OPENCODE_KNOWLEDGE_SECRET_PREVIOUS ? [process.env.OPENCODE_KNOWLEDGE_SECRET_PREVIOUS] : [])],
        redisURL: process.env.OPENCODE_REDIS_URL ?? process.env.OPENCODE_REGISTRY_URL,
        version: OPENCODE_VERSION,
      }),
    )
    console.log(`knowledge service listening on ${running.url}`)
    process.once("SIGTERM", () => void running.stop().then(() => process.exit(0)))
    process.once("SIGINT", () => void running.stop().then(() => process.exit(0)))
    // The service's server keeps the process alive.
    return yield* Effect.never
  }),
)
