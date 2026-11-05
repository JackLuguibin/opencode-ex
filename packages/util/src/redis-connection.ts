export * as RedisConnection from "./redis-connection.js"

import { RedisClient } from "bun"

const RECONNECT_MS = 1_000

/**
 * A Redis client that keeps reconnecting for as long as it is open. Bun's client stops after `maxRetries` failed
 * attempts (20 by default), runs `onclose` and then fails every command for good, so a Redis restart or a network
 * outage longer than that left layers unable to renew their lease and gateways unable to list layers until the
 * process was restarted. Here the retry budget is unlimited, and a connection that closes anyway is re-opened.
 */
export function connect(url: string) {
  let stopped = false
  const client = new RedisClient(url, { maxRetries: 4_294_967_295 })
  const reopen = () => {
    if (stopped) return
    setTimeout(() => {
      if (!stopped) void client.connect().catch(reopen)
    }, RECONNECT_MS)
  }
  client.onclose = reopen
  const close = client.close.bind(client)
  client.close = () => {
    stopped = true
    close()
  }
  return client
}
