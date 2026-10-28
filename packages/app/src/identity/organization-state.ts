import type { Platform } from "@/runtime/platform/platform"
import { removeWindowPersisted } from "@/runtime/persistence/storage"

const MARKER = "opencode.organization"
const PENDING = "opencode.organization.pending"

// Tabs point at sessions and directories of the organization that opened them. Another organization can't open
// those, so every request from a restored tab would fail with "not found".
const TAB_KEYS = ["tabs", "tabs.recent", "tabs.info", "tabs.panes", "tabs.closed"]

function read(key: string) {
  try {
    return localStorage.getItem(key) ?? undefined
  } catch {
    return undefined
  }
}

function write(key: string, value: string | undefined) {
  try {
    if (value === undefined) localStorage.removeItem(key)
    else localStorage.setItem(key, value)
  } catch {
    // Without storage there is nothing stale to restore either.
  }
}

/**
 * True when the saved tabs belong to another organization and a reset is now queued, so the caller reloads. The
 * tabs are cleared at the next start, before anything reads them: clearing them in a running app would let its
 * stores write them back.
 */
export function queueOrganizationReset(organizationID: string) {
  if (read(MARKER) === organizationID || read(PENDING) === organizationID) return false
  write(PENDING, organizationID)

  return true
}

/** Runs a queued reset. Call it before the app renders. */
export function applyOrganizationReset(platform: Platform) {
  const organizationID = read(PENDING)

  if (!organizationID) return
  TAB_KEYS.forEach((key) => removeWindowPersisted(key, platform))
  write(MARKER, organizationID)
  write(PENDING, undefined)
}
