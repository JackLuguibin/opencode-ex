import { createHash, randomBytes, scrypt, timingSafeEqual } from "node:crypto"
import { promisify } from "node:util"
import { Data } from "effect"

export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000
const scryptAsync = promisify(scrypt) as (password: string, salt: Buffer, keylen: number) => Promise<Buffer>

export class Rejected extends Data.TaggedError("Identity.Rejected")<{
  readonly reason: "invalid" | "taken" | "forbidden" | "missing" | "credentials" | "self"
}> {}

export const SETTINGS_PAGES = [
  "providers",
  "models",
  "servers",
  "general",
  "appearance",
  "notifications",
  "shortcuts",
  "extensions",
  "projects",
  "workspaces",
  "experimental",
  "about",
] as const
/** What ordinary members of an organization see until an admin configures it. */
export const DEFAULT_SETTINGS_PAGES: ReadonlyArray<string> = ["providers", "models", "servers"]


/** Client-owned state kept per account; the server stores the text as given. */
export const PREFERENCE_MAX_BYTES = 512 * 1024

export function validPreferenceKey(key: string) {
  return /^[A-Za-z0-9._:-]{1,256}$/.test(key)
}

export function normalizeEmployeeID(input: string) {
  const value = input.trim()
  if (!value || value.length > 64 || /[\s/\\?#]/.test(value)) return
  return value
}

export function validPassword(input: string) {
  return input.length >= 8 && input.length <= 128
}

export function identifier(prefix: string) {
  return `${prefix}_${randomBytes(16).toString("hex")}`
}

export function tokenHash(token: string) {
  return createHash("sha256").update(token).digest("hex")
}

export function hashPassword(password: string) {
  const salt = randomBytes(16)
  return scryptAsync(password, salt, 32).then(
    (key) => `scrypt$${salt.toString("base64url")}$${key.toString("base64url")}`,
  )
}

export function verifyPassword(password: string, stored: string) {
  const [algorithm, salt, expected] = stored.split("$")
  if (algorithm !== "scrypt" || !salt || !expected) return Promise.resolve(false)
  const actual = Buffer.from(expected, "base64url")
  return scryptAsync(password, Buffer.from(salt, "base64url"), actual.length).then(
    (key) => key.length === actual.length && timingSafeEqual(key, actual),
  )
}
