export * as Context from "./context.js"

import { createHmac, timingSafeEqual } from "node:crypto"
import type { Knowledge } from "./knowledge.js"

/** Header an execution layer sets on every call, vouching for who is asking. */
export const HEADER = "x-opencode-knowledge"

/** Short, because it is minted per call. */
export const TTL_SECONDS = 60

export function sign(secret: string, context: Knowledge.Context, now = Date.now()) {
  const payload = Buffer.from(JSON.stringify({ ...context, exp: Math.floor(now / 1000) + TTL_SECONDS })).toString("base64url")
  return `${payload}.${mac(secret, payload)}`
}

/** Who the header vouches for, or undefined when it is malformed, forged or expired. */
export function verify(secrets: string | ReadonlyArray<string>, header: string, now = Date.now()): Knowledge.Context | undefined {
  const parts = header.split(".")
  if (parts.length !== 2) return undefined
  const actual = Buffer.from(parts[1])
  const trusted = (Array.isArray(secrets) ? secrets : [secrets]).some((secret) => {
    const expected = Buffer.from(mac(secret, parts[0]))
    return actual.length === expected.length && timingSafeEqual(actual, expected)
  })
  if (!trusted) return undefined
  const { exp, ...context } = JSON.parse(Buffer.from(parts[0], "base64url").toString()) as Knowledge.Context & { exp: number }
  if (!Number.isSafeInteger(exp) || exp * 1000 <= now) return undefined
  return context
}

function mac(secret: string, payload: string) {
  return createHmac("sha256", createHmac("sha256", secret).update("opencode-knowledge-v1").digest()).update(payload).digest("base64url")
}
