export * as IdentitySecret from "./secret.js"

import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto"

/** The keys that seal and open secrets kept in the shared store. */
export type Keys = {
  readonly current: Buffer
  /** Earlier keys, still accepted for reading so a key can be rotated without losing what it sealed. */
  readonly previous: ReadonlyArray<Buffer>
}

/**
 * Reads the keys from `OPENCODE_SECRET_KEY` and `OPENCODE_SECRET_KEY_PREVIOUS` (comma separated); each is 32 bytes in
 * base64. Without a valid current key nothing is sealed, so the feature stays off instead of storing plaintext.
 */
export function fromEnv(env: Record<string, string | undefined> = process.env): Keys | undefined {
  const current = decode(env.OPENCODE_SECRET_KEY)
  if (!current) return undefined
  const previous = (env.OPENCODE_SECRET_KEY_PREVIOUS ?? "").split(",").flatMap((value) => decode(value.trim()) ?? [])
  return { current, previous }
}

/** `v1:<key id>:<iv>:<tag>:<ciphertext>`; the key id says which key sealed it without revealing the key. */
export function seal(keys: Keys, plaintext: string) {
  const iv = randomBytes(12)
  const cipher = createCipheriv("aes-256-gcm", keys.current, iv)
  const data = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()])
  return ["v1", id(keys.current), iv.toString("base64"), cipher.getAuthTag().toString("base64"), data.toString("base64")].join(":")
}

/** The plaintext, or undefined when no known key opens it or it was altered. */
export function open(keys: Keys, sealed: string) {
  const [version, keyID, iv, tag, data] = sealed.split(":")
  if (version !== "v1" || !keyID || !iv || !tag || !data) return undefined
  const key = [keys.current, ...keys.previous].find((candidate) => id(candidate) === keyID)
  if (!key) return undefined
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64"))
  decipher.setAuthTag(Buffer.from(tag, "base64"))
  try {
    return Buffer.concat([decipher.update(Buffer.from(data, "base64")), decipher.final()]).toString("utf8")
  } catch {
    // Authentication failed: the key is wrong for this value or the value was changed.
    return undefined
  }
}

/** The key that sealed a value, so rows still on an older key can be found and resealed. */
export const sealedWith = (sealed: string) => sealed.split(":")[1]

export const id = (key: Buffer) => createHash("sha256").update(key).digest("hex").slice(0, 8)

function decode(value: string | undefined) {
  if (!value) return undefined
  const key = Buffer.from(value, "base64")
  return key.length === 32 ? key : undefined
}
