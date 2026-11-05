export * as Redis from "./redis.js"

import { RedisClient } from "bun"
import { RedisConnection } from "@opencode/util/redis-connection"

export function connect(url: string) {
  return RedisConnection.connect(url)
}

// A subscription is lost when the connection drops, and the client does not resubscribe by itself. So this one does not
// reconnect quietly: it closes, and the caller subscribes again on a fresh connection.
export function subscriber(url: string) {
  return new RedisClient(url, { autoReconnect: false })
}
