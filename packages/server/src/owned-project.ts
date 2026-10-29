import { Identity } from "@opencode/core/identity"
import { Project } from "@opencode/core/project"
import type { Session } from "@opencode/core/session"
import { AbsolutePath } from "@opencode/core/schema"
import { ForbiddenError, LocationNotFoundError, SessionNotFoundError } from "@opencode/protocol/errors"
import { Effect } from "effect"
import path from "node:path"
import type { Access } from "./access"
import { canSee } from "./visibility"

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
    // A platform admin may use folders outside any organization, such as the global config; inside one they are held to its rules.
    const held = { ...access, admin: false }
    if (access.admin && !(yield* insideOrganization(directory, held, identity))) return
    // Claiming a project would otherwise let a member take any directory on the host. The organization directory only
    // holds its projects, so it can't be one itself.
    if (!(yield* insideOrganization(directory, held, identity, { exclusive: true })))
      return yield* new LocationNotFoundError({ location, message: `Location not found: ${directory}` })
    const resolved = yield* project.resolve(AbsolutePath.make(directory))
    const allowed = yield* identity.claimOrAllow(resolved.id, {
      userID: access.userID,
      organizationID: access.organizationID,
    })
    if (!allowed) return yield* new LocationNotFoundError({ location, message: `Location not found: ${directory}` })
    // Someone else's private project can't be used to start sessions either.
    const shared = yield* identity.projectAccess(resolved.id)
    if (shared && !canSee(access, shared.visibility, shared.creatorUserID))
      return yield* new LocationNotFoundError({ location, message: `Location not found: ${directory}` })
  })
}

/**
 * Users may only browse and create folders inside their organization's directory. `exclusive` also rules out the
 * directory itself, which only holds projects. Every member may change files anywhere in the shared space.
 */
export function insideOrganization(
  target: string,
  access: Access,
  identity: Identity.Interface,
  options?: { readonly exclusive?: boolean; readonly write?: boolean },
) {
  return Effect.gen(function* () {
    if (access.kind === "operator" || (access.kind === "user" && access.admin)) return true
    if (access.kind !== "user" || !access.organizationID) return false
    const root = yield* identity.organizationRoot(access.organizationID)
    const relative = path.relative(root, path.resolve(target))
    if (relative === "") return !options?.exclusive
    if (relative.startsWith("..") || path.isAbsolute(relative)) return false
    return true
  })
}

export function requireOwnedProject(
  projectID: Project.ID,
  sessionID: Session.ID,
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
    if (!allowed) return yield* missingSession(sessionID)
    // Private projects and private sessions are as good as missing for everyone but their creator and the admins.
    const project = yield* identity.projectAccess(projectID)
    if (project && !canSee(access, project.visibility, project.creatorUserID)) return yield* missingSession(sessionID)
    const session = yield* identity.sessionAccess(sessionID)
    if (session && !canSee(access, session.visibility, session.creatorUserID)) return yield* missingSession(sessionID)
  })
}

function missingSession(sessionID: string) {
  return new SessionNotFoundError({ sessionID, message: `Session not found: ${sessionID}` })
}

/** Terminals and shell commands start wherever the request says; for members that must stay inside their organization. */
export const requireWorkingDirectory = Effect.fnUntraced(function* (
  directory: string,
  access: Access,
  identity: Identity.Interface,
) {
  if (yield* insideOrganization(directory, access, identity, { write: true })) return
  return yield* new ForbiddenError({ message: "Working directory is outside your organization" })
})
