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


/** What members may download until an admin says otherwise: plain text formats, one megabyte each. */
export const DEFAULT_DOWNLOAD_EXTENSIONS: ReadonlyArray<string> = [
  "md",
  "txt",
  "csv",
  "json",
  "log",
  "yaml",
  "yml",
  "xml",
  "ini",
  "toml",
]
export const DEFAULT_DOWNLOAD_MAX_BYTES = 1024 * 1024
/** An allow-list entry that lets every file type through. */
export const ANY_EXTENSION = "*"

export type DownloadPolicy = { readonly extensions: ReadonlyArray<string>; readonly maxBytes: number }

/**
 * Normalizes the file extensions an admin allows for download: lowercase, no leading dot, letters, digits, `_`, `+`
 * and `-` only, or `*` for every type. Returns undefined when an entry is not an extension.
 */
export function normalizeExtensions(input: ReadonlyArray<string>) {
  const list = input.map((item) => item.trim().replace(/^\.+(?=.)/, "").toLowerCase()).filter(Boolean)
  if (!list.every((item) => item === ANY_EXTENSION || /^[a-z0-9_+-]{1,16}$/.test(item))) return undefined
  return [...new Set(list)].toSorted()
}

/** Whether a file may be downloaded under an organization's allow-list. */
export function downloadAllowed(extensions: ReadonlyArray<string>, filename: string) {
  if (extensions.includes(ANY_EXTENSION)) return true
  const name = filename.slice(filename.lastIndexOf("/") + 1)
  const dot = name.lastIndexOf(".")
  return dot > 0 && extensions.includes(name.slice(dot + 1).toLowerCase())
}

/** The longest introduction an organization may show on the public start page. */
export const INTRO_MAX = 280

/** How many days of token use the public start page charts, today included. Days are UTC. */
export const CHART_DAYS = 30

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

/** A member's display name: trimmed, at most 64 characters; an empty one means none. */
export function normalizeName(input: string | undefined) {
  const value = input?.trim()
  if (!value) return null
  return value.length > 64 ? undefined : value
}

export function validPassword(input: string) {
  return input.length >= 8 && input.length <= 128
}

export function identifier(prefix: string) {
  return `${prefix}_${randomBytes(16).toString("hex")}`
}

// A guest account is an ordinary account that nothing can sign in to with a password; the employee ID carries the
// prefix so the app can present the account as a guest and mark who is not a real employee.
export const GUEST_EMPLOYEE_PREFIX = "guest_"

export function guestEmployeeID() {
  return `${GUEST_EMPLOYEE_PREFIX}${randomBytes(16).toString("hex")}`
}

export function isGuestEmployeeID(employeeID: string) {
  return employeeID.startsWith(GUEST_EMPLOYEE_PREFIX)
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
