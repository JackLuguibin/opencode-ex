import { describe, expect } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { Effect, Layer } from "effect"
import { GlobalPackage } from "@opencode/core/global-package"
import { GlobalSync } from "@opencode/core/global-sync"
import { SharedMcp } from "@opencode/core/shared-mcp"
import { Global } from "@opencode/util/global"
import { tmpdirScoped } from "./fixture/tmpdir"
import { it } from "./lib/effect"
import { zip } from "./lib/zip"

const layer = (root: string) =>
  Layer.mergeAll(GlobalPackage.layer, SharedMcp.layer).pipe(
    Layer.provide(Layer.succeed(Global.Service, Global.make({ config: path.join(root, "config"), data: path.join(root, "data") }))),
  )

const skill = (name: string, body: string) => zip([{ name: `${name}/SKILL.md`, data: `---\nname: ${name}\ndescription: ${body}\n---\n` }])

describe("GlobalSync", () => {
  it.live("a layer that is behind ends up with exactly the managed state of the one it copies", () =>
    Effect.gen(function* () {
      const source = yield* tmpdirScoped()
      const target = yield* tmpdirScoped()
      yield* Effect.gen(function* () {
        const packages = yield* GlobalPackage.Service
        const mcp = yield* SharedMcp.Service
        yield* packages.install({ kind: "skill", name: "keep", uploadedBy: "9000", organizations: ["org_a"], archive: skill("keep", "new") })
        yield* packages.install({ kind: "skill", name: "added", uploadedBy: "9000", organizations: ["org_b"], archive: skill("added", "added") })
        yield* mcp.save({
          name: "docs",
          server: { type: "remote", url: "https://example.com/mcp" },
          createdBy: "9000",
          organizations: ["org_a"],
        })
      }).pipe(Effect.provide(layer(source.path)))

      // The behind layer has an older copy of one package, a package that was since deleted, and one placed by hand.
      yield* Effect.gen(function* () {
        const packages = yield* GlobalPackage.Service
        yield* packages.install({ kind: "skill", name: "keep", uploadedBy: "9000", organizations: [], archive: skill("keep", "old") })
        yield* packages.install({ kind: "skill", name: "gone", uploadedBy: "9000", organizations: [], archive: skill("gone", "gone") })
      }).pipe(Effect.provide(layer(target.path)))
      yield* Effect.promise(async () => {
        await fs.mkdir(path.join(target.path, "config", "skills", "by-hand"), { recursive: true })
        await Bun.write(path.join(target.path, "config", "skills", "by-hand", "SKILL.md"), "mine")
      })

      const archive = yield* Effect.promise(() => GlobalSync.snapshot(path.join(source.path, "config"), path.join(source.path, "data")))
      yield* Effect.promise(() => GlobalSync.restore(path.join(target.path, "config"), path.join(target.path, "data"), archive))

      yield* Effect.gen(function* () {
        const packages = yield* GlobalPackage.Service
        const mcp = yield* SharedMcp.Service
        const listed = yield* packages.list()
        expect(listed.map((item) => [item.name, item.description, item.organizations])).toEqual([
          ["added", "added", ["org_b"]],
          ["keep", "new", ["org_a"]],
        ])
        expect((yield* mcp.list()).map((entry) => [entry.name, entry.organizations])).toEqual([["docs", ["org_a"]]])
      }).pipe(Effect.provide(layer(target.path)))
      // Not a managed package, so it was neither listed, replaced nor removed.
      expect(yield* Effect.promise(() => Bun.file(path.join(target.path, "config", "skills", "by-hand", "SKILL.md")).text())).toBe("mine")
      expect(yield* Effect.promise(() => fs.readdir(path.join(target.path, "data", "organization-packages")))).not.toContain(
        expect.stringMatching(/^\.sync-/),
      )
    }),
  )

  it.live("copying an empty state clears the shared MCP servers and packages that were there", () =>
    Effect.gen(function* () {
      const empty = yield* tmpdirScoped()
      const target = yield* tmpdirScoped()
      yield* Effect.gen(function* () {
        const packages = yield* GlobalPackage.Service
        const mcp = yield* SharedMcp.Service
        yield* packages.install({ kind: "skill", name: "old", uploadedBy: "9000", organizations: [], archive: skill("old", "old") })
        yield* mcp.save({ name: "docs", server: { type: "remote", url: "https://example.com/mcp" }, createdBy: "9000", organizations: [] })
      }).pipe(Effect.provide(layer(target.path)))

      const archive = yield* Effect.promise(() => GlobalSync.snapshot(path.join(empty.path, "config"), path.join(empty.path, "data")))
      yield* Effect.promise(() => GlobalSync.restore(path.join(target.path, "config"), path.join(target.path, "data"), archive))

      yield* Effect.gen(function* () {
        expect(yield* (yield* GlobalPackage.Service).list()).toEqual([])
        expect(yield* (yield* SharedMcp.Service).list()).toEqual([])
      }).pipe(Effect.provide(layer(target.path)))
    }),
  )
})
