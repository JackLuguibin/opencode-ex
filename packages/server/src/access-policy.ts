import type { Account } from "@opencode/core/identity"

/**
 * What a signed-in user needs for a route beyond being signed in. State shared by every organization (global config,
 * plugin packages, well-known integrations) is the platform admin's. Changes behind a settings page need that page,
 * which an admin grants per organization; the page is hidden in the UI, and this is what keeps the API in step.
 */
export function requirement(method: string, path: string) {
  if (method === "GET" || method === "HEAD" || method === "OPTIONS") return undefined
  if (PLATFORM.has(`${method} ${path}`)) return "platform" as const
  if (path.startsWith("/api/experimental/mcp/")) return "extensions" as const
  if (path.startsWith("/api/integration/")) return "providers" as const
  return undefined
}

export function allows(account: Pick<Account, "admin" | "settingsPages">, required: ReturnType<typeof requirement>) {
  if (!required || account.admin) return true
  return required !== "platform" && account.settingsPages.includes(required)
}

const PLATFORM = new Set([
  "PATCH /api/experimental/config",
  "POST /api/plugin/check",
  "POST /api/plugin/update",
  "POST /api/experimental/integration/wellknown",
])

/** Routes that change or remove a session rather than use it; only its creator and the organization's admins may. */
export function managesSession(method: string, path: string) {
  return (
    ((method === "DELETE" || method === "PATCH") && path === "/api/session/:sessionID") ||
    (method === "POST" && path === "/api/session/:sessionID/move") ||
    (method === "PUT" && path === "/api/session/:sessionID/visibility")
  )
}
