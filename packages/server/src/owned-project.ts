import { Identity } from "@opencode/core/identity"
import { Project } from "@opencode/core/project"
import { AbsolutePath } from "@opencode/core/schema"
import { LocationNotFoundError, SessionNotFoundError } from "@opencode/protocol/errors"
import { Effect } from "effect"
import path from "node:path"
import type { Access } from "./access"

export function requireOwnedDirectory(
  directory: string,
  access: Access,
  project: Project.Interface,
  identity: Identity.Interface,
) {
  return Effect.gen(function* () {
    if (access.kind === "operator") return
    const location = { directory: AbsolutePath.make(directory) }
    if (access.kind !== "user" || !access.organizationID) {
      return yield* new LocationNotFoundError({ location, message: `Location not found: ${directory}` })
    }
    // The organization directory only holds its projects; it can't be one itself.
    const root = path.dirname(yield* identity.organizationDirectory(access.organizationID))
    if (path.resolve(directory) === root)
      return yield* new LocationNotFoundError({ location, message: `Location not found: ${directory}` })
    const resolved = yield* project.resolve(AbsolutePath.make(directory))
    const allowed = yield* identity.claimOrAllow(resolved.id, {
      userID: access.userID,
      organizationID: access.organizationID,
    })
    if (allowed) return
    return yield* new LocationNotFoundError({ location, message: `Location not found: ${directory}` })
  })
}

export function requireOwnedProject(
  projectID: Project.ID,
  sessionID: string,
  access: Access,
  identity: Identity.Interface,
) {
  return Effect.gen(function* () {
    if (access.kind === "operator") return
    if (access.kind !== "user" || !access.organizationID) return yield* missingSession(sessionID)
    const allowed = yield* identity.claimOrAllow(projectID, {
      userID: access.userID,
      organizationID: access.organizationID,
    })
    if (allowed) return
    return yield* missingSession(sessionID)
  })
}

function missingSession(sessionID: string) {
  return new SessionNotFoundError({ sessionID, message: `Session not found: ${sessionID}` })
}
