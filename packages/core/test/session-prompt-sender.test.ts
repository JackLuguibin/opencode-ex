import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { eq } from "drizzle-orm"
import { Bus } from "@opencode/core/bus"
import { Credential } from "@opencode/core/credential"
import { Database } from "@opencode/core/database/database"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { Watcher } from "@opencode/core/filesystem/watcher"
import { IdentityUserTable } from "@opencode/core/identity/sql"
import { LocationServiceMap } from "@opencode/core/location-service-map"
import { AbsolutePath } from "@opencode/core/schema"
import { Session } from "@opencode/core/session"
import { SessionExecution } from "@opencode/core/session/execution"
import { SessionProjector } from "@opencode/core/session/projector"
import { SessionInboxTable } from "@opencode/core/session/sql"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { Global } from "@opencode/util/global"
import { tempGlobalLayer } from "./fixture/global"
import { offlineModels } from "./fixture/models"
import { tmpdirScoped } from "./fixture/tmpdir"
import { testEffect } from "./lib/effect"

const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([Database.node, Bus.node, SessionProjector.node, Session.node, LocationServiceMap.node]),
    [
      Global.node.replace(tempGlobalLayer),
      offlineModels,
      Watcher.node.replace(Watcher.configured({ enabled: false })),
      SessionExecution.node.replace(SessionExecution.noopLayer),
    ],
  ),
)

describe("Session.prompt sender", () => {
  it.live("records the acting user on the admitted prompt, and none without one", () =>
    Effect.gen(function* () {
      const tmp = yield* tmpdirScoped()
      const db = (yield* Database.Service).db
      yield* db
        .insert(IdentityUserTable)
        .values({ id: "usr_actor", employee_id: "actor", password_hash: "x", admin: false })
        .run()
      const sessions = yield* Session.Service
      const session = yield* sessions.create({ location: { directory: AbsolutePath.make(tmp.path) } })
      const sender = (id: string) =>
        db.select({ userID: SessionInboxTable.user_id }).from(SessionInboxTable).where(eq(SessionInboxTable.id, id as never)).get()

      const acted = yield* sessions
        .prompt({ sessionID: session.id, text: "from a user", resume: false })
        .pipe(Effect.provideService(Credential.Actor, { userID: "usr_actor", admin: false }))
      expect(yield* sender(acted.id)).toEqual({ userID: "usr_actor" })

      const anonymous = yield* sessions.prompt({ sessionID: session.id, text: "from the cli", resume: false })
      expect(yield* sender(anonymous.id)).toEqual({ userID: null })
    }),
  )
})
