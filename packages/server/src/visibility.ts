import type { Identity } from "@opencode/core/identity"
import type { Access } from "./access"

type Member = Extract<Access, { kind: "user" }>

/**
 * Who may change a project or a session: its creator, and the admins of the organization. Everyone else in the
 * organization can use what is shared with them but not delete, rename, move or re-scope it.
 */
export function canManage(access: Access, creatorUserID: string | undefined) {
  if (access.kind === "operator") return true
  if (access.kind !== "user") return false
  return access.admin || access.organizationAdmin || (!!creatorUserID && creatorUserID === access.userID)
}

/** Private things are only for those who could manage them. */
export function canSee(access: Access, visibility: Identity.Visibility, creatorUserID: string | undefined) {
  return visibility === "organization" || canManage(access, creatorUserID)
}

/** The user ID of a signed-in member, for filters that hide other people's private sessions. */
export function visibleTo(access: Access): string | undefined {
  if (access.kind !== "user" || access.admin || access.organizationAdmin) return undefined
  return (access as Member).userID
}

// Bumped whenever something is made private or visible again, so cached answers about who may see what are dropped at
// once rather than when they happen to expire.
let epoch = 0
export const visibilityChanged = () => void epoch++
export const visibilityEpoch = () => epoch
