export * as ProjectRemoval from "./removal.js"

import { and, eq, isNull } from "drizzle-orm"
import { Effect } from "effect"
import type { Database } from "../database/database.js"
import type { Project } from "../project.js"
import type { Session } from "../session.js"
import { SessionTable } from "../session/sql.js"
import { ProjectTable } from "./sql.js"

/** The folder a project lives in and the organization that owns it. */
export const describe = Effect.fnUntraced(function* (db: Database.Interface["db"], projectID: Project.ID) {
  return yield* db
    .select({ worktree: ProjectTable.worktree, organizationID: ProjectTable.organization_id })
    .from(ProjectTable)
    .where(eq(ProjectTable.id, projectID))
    .get()
    .pipe(Effect.orDie)
})

/** Deletes a project after its sessions. Removing each top-level session records its deletion and takes its subagents. */
export const remove = Effect.fnUntraced(function* (
  db: Database.Interface["db"],
  sessions: Session.Interface,
  project: Project.Interface,
  projectID: Project.ID,
) {
  const roots = yield* db
    .select({ id: SessionTable.id })
    .from(SessionTable)
    .where(and(eq(SessionTable.project_id, projectID), isNull(SessionTable.parent_id)))
    .all()
    .pipe(Effect.orDie)
  yield* Effect.forEach(
    roots,
    (item) => sessions.remove(item.id).pipe(Effect.catchTag("Session.NotFoundError", () => Effect.void)),
    { discard: true },
  )
  yield* project.remove(projectID)
})
