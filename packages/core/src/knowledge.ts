export * as Knowledge from "./knowledge.js"

import { Context as KnowledgeContext } from "@opencode/knowledge/context"
import { KnowledgeRegistry } from "@opencode/util/knowledge-registry"
import { RedisConnection } from "@opencode/util/redis-connection"
import { makeGlobalNode } from "@opencode/util/effect/app-node"
import { Global } from "@opencode/util/global"
import { randomBytes } from "node:crypto"
import path from "node:path"
import { Context, Effect, Layer } from "effect"

/** Who is asking; the knowledge service decides what they may see from it. */
export type Actor = { readonly userID: string; readonly admin: boolean; readonly organizationID: string | undefined }

export type Query = Readonly<Record<string, string | undefined>>

/** The service's reply, with failures turned into a status and message instead of an error to handle. */
export type Answer = { readonly status: number; readonly message: string; readonly body: unknown }

export interface Interface {
  readonly call: (
    actor: Actor,
    input: { readonly method: string; readonly path: string; readonly query?: Query; readonly body?: unknown },
  ) => Effect.Effect<Answer>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/Knowledge") {}

const DISCOVERY_TTL_MS = 5_000
const CALL_TIMEOUT_MS = 30_000

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const global = yield* Global.Service
    const fixed = process.env.OPENCODE_KNOWLEDGE_URL
    const redisURL = process.env.OPENCODE_REDIS_URL ?? process.env.OPENCODE_REGISTRY_URL
    const secret = process.env.OPENCODE_KNOWLEDGE_SECRET
    // Without a shared service, the layer runs its own copy in this process. It is only reachable through this layer, so
    // the secret never leaves it.
    const local = secret ?? randomBytes(24).toString("base64url")

    let redis: ReturnType<typeof RedisConnection.connect> | undefined
    let found: { readonly url: string; readonly at: number } | undefined
    let embedded: Promise<(request: Request) => Promise<Response>> | undefined

    const discover = async (refresh: boolean) => {
      if (fixed) return fixed
      if (!redisURL) return undefined
      if (!refresh && found && Date.now() - found.at < DISCOVERY_TTL_MS) return found.url
      redis ??= RedisConnection.connect(redisURL)
      const service = await KnowledgeRegistry.lookup(redis).catch(() => undefined)
      found = service ? { url: service.url, at: Date.now() } : undefined
      return found?.url
    }

    const inProcess = () =>
      (embedded ??= Promise.all([import("@opencode/knowledge/knowledge"), import("@opencode/knowledge/server")]).then(
        ([knowledge, server]) =>
          server.Server.make({ service: knowledge.Knowledge.open(path.join(global.data, "knowledge", "knowledge.db")), secrets: [local] }),
      ))

    const unavailable = (message: string): Answer => ({ status: 503, message, body: undefined })

    const send = async (url: string | undefined, request: (base: string) => Request) => {
      if (url) return fetch(request(url), { signal: AbortSignal.timeout(CALL_TIMEOUT_MS) })
      const handle = await mkdirFor(global.data).then(inProcess)
      return handle(request("http://knowledge.local"))
    }

    const call: Interface["call"] = (actor, input) =>
      Effect.promise(async (): Promise<Answer> => {
        if ((fixed || redisURL) && !secret) return unavailable("OPENCODE_KNOWLEDGE_SECRET is not set on this layer")
        const query = new URLSearchParams(Object.entries(input.query ?? {}).flatMap(([key, value]): [string, string][] => (value === undefined ? [] : [[key, value]])))
        const request = (base: string) =>
          new Request(`${base.replace(/\/+$/, "")}${input.path}${query.size > 0 ? `?${query}` : ""}`, {
            method: input.method,
            headers: {
              "content-type": "application/json",
              [KnowledgeContext.HEADER]: KnowledgeContext.sign(local, actor),
            },
            body: input.body === undefined ? undefined : JSON.stringify(input.body),
          })
        const attempt = async (refresh: boolean) => send(await discover(refresh), request)
        // A service that moved or restarted has a new address, so one failed call re-reads the registry before giving up.
        const response = await attempt(false).catch(() => attempt(true)).catch(() => undefined)
        if (!response) return unavailable("The knowledge service is not reachable")
        const body: unknown = response.status === 204 ? undefined : await response.json().catch(() => undefined)
        const message = typeof body === "object" && body !== null && "message" in body ? String((body as { message: unknown }).message) : ""
        return { status: response.status, message, body }
      })

    return Service.of({ call })
  }),
)

export const node = makeGlobalNode({ service: Service, layer, deps: [Global.node] })

const mkdirFor = (data: string) => import("node:fs/promises").then((fs) => fs.mkdir(path.join(data, "knowledge"), { recursive: true }))
