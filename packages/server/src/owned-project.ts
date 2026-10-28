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
    const root = yield* identity.organizationRoot(access.organizationID)
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

/**
 * Users may only browse and create folders inside their organization's directory. `exclusive` also rules out the
 * directory itself, which only holds projects. `write` is for changes: inside the organization's shared space, members
 * may only change their own subfolder (named by employee ID), while admins of the organization may change anything there.
 */
export function insideOrganization(
  target: string,
  access: Access,
  identity: Identity.Interface,
  options?: { readonly exclusive?: boolean; readonly write?: boolean },
) {
  return Effect.gen(function* () {
    if (access.kind === "operator") return true
    if (access.kind !== "user" || !access.organizationID) return false
    const root = yield* identity.organizationRoot(access.organizationID)
    const relative = path.relative(root, path.resolve(target))
    if (relative === "") return !options?.exclusive
    if (relative.startsWith("..") || path.isAbsolute(relative)) return false
    if (!options?.write || access.organizationAdmin) return true
    const shared = yield* identity.organizationSharedDirectory(access.organizationID)
    const inShared = path.relative(shared, path.resolve(target))
    if (inShared.startsWith("..") || path.isAbsolute(inShared)) return true
    const own = inShared.split(path.sep)[0] === access.employeeID
    return own
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
