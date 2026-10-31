import { describe, expect } from "bun:test"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { Bus } from "@opencode/core/bus"
import { Database } from "@opencode/core/database/database"
import { Identity } from "@opencode/core/identity"
import { Location } from "@opencode/core/location"
import { Project } from "@opencode/core/project"
import { AbsolutePath } from "@opencode/core/schema"
import { Session } from "@opencode/core/session"
import { SessionExecution } from "@opencode/core/session/execution"
import { SessionProjector } from "@opencode/core/session/projector"
import { SessionStore } from "@opencode/core/session/store"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { Effect } from "effect"
import { testEffect } from "./lib/effect"
import { globalProjectNode } from "./lib/project"

const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([Database.node, Bus.node, SessionProjector.node, SessionStore.node, Session.node, Identity.node]),
    [
      Bus.node.replace(Bus.configured({ persist: true })),
      Project.node.replace(globalProjectNode),
      SessionExecution.node.replace(SessionExecution.noopLayer),
    ],
  ),
)
const project = Location.Ref.make({ directory: AbsolutePath.make("/project") })

describe("session user", () => {
  it.effect("follows the user who last continued a session and lets subagents inherit it", () =>
    Effect.gen(function* () {
      const identity = yield* Identity.Service
      const session = yield* Session.Service
      const first = yield* identity.register({ employeeID: "7001", password: "password-1" })
      const second = yield* identity.register({ employeeID: "7002", password: "password-1" })
      const firstUser = (yield* identity.authenticate(first.token))!.userID
      const secondUser = (yield* identity.authenticate(second.token))!.userID

      const parent = yield* session.create({ location: project })
      const child = yield* session.create({ parentID: parent.id })
      expect(yield* identity.sessionUser(parent.id)).toBeUndefined()

      yield* identity.touchSessionUser(parent.id, firstUser)
      expect(yield* identity.sessionUser(child.id)).toBe(firstUser)
      // Whoever continues the session next takes over its credentials, subagents included.
      yield* identity.touchSessionUser(parent.id, secondUser)
      expect(yield* identity.sessionUser(parent.id)).toBe(secondUser)
      expect(yield* identity.sessionUser(child.id)).toBe(secondUser)
      yield* identity.touchSessionUser(child.id, firstUser)
      expect(yield* identity.sessionUser(child.id)).toBe(firstUser)
    }),
  )

  it.effect("offers the user's employee ID to request headers", () =>
    Effect.gen(function* () {
      const identity = yield* Identity.Service
      const session = yield* Session.Service
      const registered = yield* identity.register({ employeeID: "7003", password: "password-1" })
      const user = (yield* identity.authenticate(registered.token))!.userID
      const created = yield* session.create({ location: project })
      expect(yield* identity.headerVariables(created.id, user)).toMatchObject({ employeeID: "7003", name: "7003" })
    }),
  )
})
