import type { SyncStorage } from "@solid-primitives/storage"
import { createSignal } from "solid-js"
import { accountFetch } from "@/identity/api"

/**
 * Client state that belongs to the account rather than the browser: project lists, pins, settings, history. It lives in
 * the shared identity store, so every browser and every execution layer sees the same values. The account gate loads it
 * once before the app renders, so stores read it synchronously; writes are cached here at once and sent shortly after.
 */
export type RemoteScope = "user" | "organization"

type Connection = { readonly url: string; readonly password: string }

const WRITE_DELAY_MS = 600

const state = {
  connection: undefined as Connection | undefined,
  values: { user: new Map<string, string>(), organization: new Map<string, string>() },
  // Keys written here and not yet sent; a refresh must not replace them.
  pending: new Map<string, ReturnType<typeof setTimeout>>(),
  // Latest value waiting to be sent, or null for a removal.
  queued: new Map<string, string | null>(),
}

const pendingKey = (scope: RemoteScope, key: string) => `${scope}\u0000${key}`

/** Loads the account's stored state. Until this succeeds, stores keep using the browser's own storage. */
export async function hydrateRemote(connection: Connection) {
  const loaded = await accountFetch<{
    user: Record<string, string>
    organization: Record<string, string>
  }>({ url: connection.url, password: connection.password, path: "/api/preference" })
  state.values.user = new Map(Object.entries(loaded.user))
  state.values.organization = new Map(Object.entries(loaded.organization))
  state.connection = connection
  const waiting = [...listeners]
  listeners.clear()
  waiting.forEach((listener) => listener())
}

/** Forgets the account's state, as on sign-out, so the next account never reads it. */
export function resetRemote() {
  void flushRemote()
  state.connection = undefined
  state.values.user.clear()
  state.values.organization.clear()
}

// Set while an account is signed in to the gateway, even if its stored state could not be loaded.
const [accountActive, setAccountActive] = createSignal(false)

export { setAccountActive }

/** Whether projects come from an organization: the server already lists only the ones this account may see. */
export function accountActiveNow() {
  return accountActive()
}

const listeners = new Set<() => void>()

/** Runs once the account's stored state is loaded, or at once if it already is. */
export function onRemoteReady(listener: () => void) {
  if (state.connection) return listener()
  listeners.add(listener)
}

export function remoteReady() {
  return state.connection !== undefined
}

export function remoteStorage(scope: RemoteScope): SyncStorage {
  return {
    getItem: (key) => state.values[scope].get(key) ?? null,
    setItem: (key, value) => {
      // Stores write back what they just read when they mount; that is not a change worth a request.
      if (state.values[scope].get(key) === value && !state.pending.has(pendingKey(scope, key))) return
      state.values[scope].set(key, value)
      queue(scope, key, value)
    },
    removeItem: (key) => {
      if (!state.values[scope].has(key) && !state.pending.has(pendingKey(scope, key))) return
      state.values[scope].delete(key)
      queue(scope, key, null)
    },
  }
}

function queue(scope: RemoteScope, key: string, value: string | null) {
  const id = pendingKey(scope, key)
  const timer = state.pending.get(id)
  if (timer) clearTimeout(timer)
  state.queued.set(id, value)
  state.pending.set(
    id,
    setTimeout(() => void send(scope, key), WRITE_DELAY_MS),
  )
}

async function send(scope: RemoteScope, key: string) {
  const id = pendingKey(scope, key)
  const connection = state.connection
  state.pending.delete(id)
  if (!connection || !state.queued.has(id)) return
  const value = state.queued.get(id) ?? null
  state.queued.delete(id)
  const path = `/api/preference/${scope}/${encodeURIComponent(key)}`
  await accountFetch({
    url: connection.url,
    password: connection.password,
    path,
    method: value === null ? "DELETE" : "PUT",
    ...(value === null ? {} : { body: { value } }),
  }).catch((error) => console.error(`[persistence] saving ${key} to the server failed`, error))
}

/** Sends everything still waiting, for when the page is closing. */
export async function flushRemote() {
  const waiting = [...state.pending.entries()]
  waiting.forEach(([, timer]) => clearTimeout(timer))
  await Promise.all(
    waiting.map(([id]) => {
      const [scope, key] = id.split("\u0000")
      return send(scope as RemoteScope, key ?? "")
    }),
  )
}

if (typeof window !== "undefined") {
  window.addEventListener("pagehide", () => void flushRemote())
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") void flushRemote()
  })
}
