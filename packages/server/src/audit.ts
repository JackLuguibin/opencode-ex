import type { Identity } from "@opencode/core/identity"
import { Effect } from "effect"
import type { Access } from "./access"

/** Notes what a signed-in member did. The operator and unauthenticated callers are not people, so they are not logged. */
export function record(
  identity: Identity.Interface,
  access: Access,
  entry: { readonly action: string; readonly target?: string; readonly detail?: string },
) {
  return access.kind === "user" ? identity.audit({ actor: access.employeeID, ...entry }) : Effect.void
}
