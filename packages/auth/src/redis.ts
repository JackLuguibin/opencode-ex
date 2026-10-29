export * as Redis from "./redis.js"

import { RedisClient } from "bun"

export function connect(url: string) {
  return new RedisClient(url)
}
