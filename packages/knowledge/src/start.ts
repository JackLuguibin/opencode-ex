export * as KnowledgeStart from "./start.js"

import { mkdir } from "node:fs/promises"
import path from "node:path"
import { randomBytes } from "node:crypto"
import { RedisConnection } from "@opencode/util/redis-connection"
import { KnowledgeRegistry } from "@opencode/util/knowledge-registry"
import { Knowledge } from "./knowledge.js"
import { Server } from "./server.js"

export type Options = {
  /** Directory holding `knowledge.db`. */
  readonly data: string
  readonly hostname: string
  readonly port: number
  /** URL execution layers should use; defaults to the listening address. */
  readonly advertise?: string
  readonly secrets: ReadonlyArray<string>
  readonly redisURL?: string
  readonly version: string
}

/**
 * Runs the knowledge service. With a Redis URL it registers itself and renews its lease, and stops serving if it loses the
 * lease; without one it just listens, which is how an execution layer runs it locally.
 */
export async function start(options: Options) {
  await mkdir(options.data, { recursive: true })
  const service = Knowledge.open(path.join(options.data, "knowledge.db"))
  const handle = Server.make({ service, secrets: options.secrets })
  const server = Bun.serve({ hostname: options.hostname, port: options.port, maxRequestBodySize: 64 * 1024 * 1024, idleTimeout: 60, fetch: handle })
  const url = options.advertise ?? `http://${options.hostname === "0.0.0.0" ? "127.0.0.1" : options.hostname}:${server.port}`
  const id = `knowledge_${randomBytes(6).toString("hex")}`

  const redis = options.redisURL ? RedisConnection.connect(options.redisURL) : undefined
  const stop = async () => {
    if (redis) await KnowledgeRegistry.release(redis, id).catch(() => undefined)
    await server.stop()
    service.close()
  }
  if (redis) {
    if (!(await claimWithin(redis, { id, url, version: options.version }, KnowledgeRegistry.LEASE_MS + 1_000))) {
      await server.stop()
      service.close()
      throw new Error("another knowledge service holds the lease; only one runs at a time")
    }
    const timer = setInterval(async () => {
      const held = await KnowledgeRegistry.renew(redis, id).catch(() => true)
      if (held) return
      // The lease is lost: another instance may be serving, so stop instead of writing next to it.
      console.error("knowledge service lost its lease; stopping")
      clearInterval(timer)
      await stop()
      process.exit(1)
    }, KnowledgeRegistry.LEASE_MS / 3)
    timer.unref()
  }
  return { url, port: server.port, stop }
}

// A service restarted quickly finds the lease of its previous run still held until it expires, so it waits that long
// before deciding another instance is serving.
async function claimWithin(redis: ReturnType<typeof RedisConnection.connect>, service: KnowledgeRegistry.Service, waitMs: number) {
  const deadline = Date.now() + waitMs
  while (true) {
    if (await KnowledgeRegistry.claim(redis, service)) return true
    if (Date.now() >= deadline) return false
    await Bun.sleep(1_000)
  }
}
