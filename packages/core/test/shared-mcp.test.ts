import { describe, expect } from "bun:test"
import path from "path"
import { Effect, Layer } from "effect"
import { SharedMcp } from "@opencode/core/shared-mcp"
import { Global } from "@opencode/util/global"
import { tmpdirScoped } from "./fixture/tmpdir"
import { it } from "./lib/effect"

const withGlobal = <A, E>(effect: Effect.Effect<A, E, SharedMcp.Service>, root: string) =>
  effect.pipe(
    Effect.provide(
      SharedMcp.layer.pipe(
        Layer.provide(Layer.succeed(Global.Service, Global.make({ config: path.join(root, "config"), data: path.join(root, "data") }))),
      ),
    ),
  )

describe("SharedMcp", () => {
  it.live("keeps secrets out of listings and only runs for organizations it is open to", () =>
    Effect.gen(function* () {
      const tmp = yield* tmpdirScoped()
      const data = path.join(tmp.path, "data")
      yield* withGlobal(
        Effect.gen(function* () {
          const mcp = yield* SharedMcp.Service
          const remote = yield* mcp.save({
            name: "search",
            server: { type: "remote", url: "https://mcp.example.com/sse", headers: { authorization: "Bearer secret-token" } },
            createdBy: "9000",
            organizations: ["org_a"],
          })
          yield* mcp.save({
            name: "files",
            server: { type: "local", command: ["npx", "-y", "files-mcp"], environment: { API_KEY: "secret-key" } },
            createdBy: "9000",
            organizations: ["org_a", "org_b"],
          })

          expect(remote).toMatchObject({ name: "search", type: "remote", target: "https://mcp.example.com/sse", organizations: ["org_a"] })
          expect(JSON.stringify(yield* mcp.list())).not.toContain("secret")
          const usable = async (organizationID: string) => (await SharedMcp.readUsable(data, organizationID)).map((item) => item.name)
          expect(yield* Effect.promise(() => usable("org_a"))).toEqual(["files", "search"])
          expect(yield* Effect.promise(() => usable("org_b"))).toEqual(["files"])
          expect(yield* Effect.promise(() => usable("org_c"))).toEqual([])

          yield* mcp.setEnabled("org_a", "files", false)
          expect(yield* Effect.promise(() => usable("org_a"))).toEqual(["search"])
          expect((yield* mcp.setEnabled("org_c", "search", true).pipe(Effect.flip))._tag).toBe("SharedMcp.NotFoundError")
          yield* mcp.setScope("search", ["org_b"])
          expect(yield* Effect.promise(() => usable("org_a"))).toEqual([])

          yield* mcp.remove("search")
          expect((yield* mcp.list()).map((item) => item.name)).toEqual(["files"])
        }),
        tmp.path,
      )
    }),
  )

  it.live("refuses malformed servers and duplicate names", () =>
    Effect.gen(function* () {
      const tmp = yield* tmpdirScoped()
      yield* withGlobal(
        Effect.gen(function* () {
          const mcp = yield* SharedMcp.Service
          const save = (name: string, server: SharedMcp.Input) => mcp.save({ name, server, createdBy: "9000", organizations: [] }).pipe(Effect.flip)

          expect((yield* save("../x", { type: "remote", url: "https://a.example" }))._tag).toBe("SharedMcp.InvalidError")
          expect((yield* save("a", { type: "remote", url: "file:///etc/passwd" }))._tag).toBe("SharedMcp.InvalidError")
          expect((yield* save("a", { type: "local", command: [" ", ""] }))._tag).toBe("SharedMcp.InvalidError")
          yield* mcp.save({ name: "dup", server: { type: "remote", url: "https://a.example" }, createdBy: "9000", organizations: [] })
          expect((yield* save("dup", { type: "remote", url: "https://b.example" }))._tag).toBe("SharedMcp.ConflictError")
        }),
        tmp.path,
      )
    }),
  )
})
