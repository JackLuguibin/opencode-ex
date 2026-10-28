import { describe, expect } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { Effect, Layer } from "effect"
import { GlobalPackage } from "@opencode/core/global-package"
import { Global } from "@opencode/util/global"
import { tmpdirScoped } from "./fixture/tmpdir"
import { it } from "./lib/effect"
import { zip } from "./lib/zip"

const withGlobal = <A, E>(effect: Effect.Effect<A, E, GlobalPackage.Service>, root: string) =>
  effect.pipe(
    Effect.provide(
      GlobalPackage.layer.pipe(
        Layer.provide(
          Layer.succeed(Global.Service, Global.make({ config: path.join(root, "config"), data: path.join(root, "data") })),
        ),
      ),
    ),
  )

describe("GlobalPackage", () => {
  it.live("installs a package, lists it, and lets an organization switch it off", () =>
    Effect.gen(function* () {
      const tmp = yield* tmpdirScoped()
      yield* withGlobal(
        Effect.gen(function* () {
          const packages = yield* GlobalPackage.Service
          const archive = zip([
            { name: "demo/SKILL.md", data: "---\nname: demo\ndescription: Does demo things\n---\nbody" },
            { name: "demo/scripts/run.sh", data: "echo hi" },
          ])
          const installed = yield* packages.install({ kind: "skill", name: "demo", uploadedBy: "9000", organizations: ["org_a"], archive })

          expect(installed).toMatchObject({ kind: "skill", name: "demo", description: "Does demo things", uploadedBy: "9000" })
          // The wrapping folder is dropped so the skill sits where discovery looks for it.
          expect(yield* Effect.promise(() => Bun.file(path.join(tmp.path, "config", "skills", "demo", "SKILL.md")).exists())).toBe(true)
          expect((yield* packages.list()).map((item) => [item.name, item.organizations])).toEqual([["demo", ["org_a"]]])

          // Only organizations a package is open to can use it; the rest never see it load.
          const hidden = (organizationID: string) =>
            Effect.promise(() => GlobalPackage.readHidden(path.join(tmp.path, "config"), path.join(tmp.path, "data"), organizationID))
          expect([...(yield* hidden("org_a"))]).toEqual([])
          expect([...(yield* hidden("org_b"))]).toEqual(["skill:demo"])
          expect((yield* packages.setEnabled("org_b", "skill", "demo", true).pipe(Effect.flip))._tag).toBe("GlobalPackage.NotFoundError")
          yield* packages.setScope("skill", "demo", ["org_b"])
          expect([...(yield* hidden("org_a"))]).toEqual(["skill:demo"])
          yield* packages.setScope("skill", "demo", ["org_a", "org_b"])

          yield* packages.setEnabled("org_a", "skill", "demo", false)
          expect([...(yield* packages.disabled("org_a"))]).toEqual(["skill:demo"])
          expect([...(yield* packages.disabled("org_b"))]).toEqual([])
          yield* packages.setEnabled("org_a", "skill", "demo", true)
          expect([...(yield* packages.disabled("org_a"))]).toEqual([])

          expect([...(yield* hidden("org_a"))]).toEqual([])
          yield* packages.setEnabled("org_a", "skill", "demo", false)
          expect([...(yield* hidden("org_a"))]).toEqual(["skill:demo"])
          yield* packages.setEnabled("org_a", "skill", "demo", true)

          yield* packages.remove("skill", "demo")
          expect(yield* packages.list()).toEqual([])
          expect([...(yield* hidden("org_b"))]).toEqual([])
        }),
        tmp.path,
      )
    }),
  )

  it.live("refuses bad archives, missing entrypoints, and names that belong to hand-placed packages", () =>
    Effect.gen(function* () {
      const tmp = yield* tmpdirScoped()
      yield* Effect.promise(async () => {
        await fs.mkdir(path.join(tmp.path, "config", "skills", "mine"), { recursive: true })
        await fs.writeFile(path.join(tmp.path, "config", "skills", "mine", "SKILL.md"), "hand made")
      })
      yield* withGlobal(
        Effect.gen(function* () {
          const packages = yield* GlobalPackage.Service
          const good = zip([{ name: "SKILL.md", data: "x" }])
          const install = (name: string, archive: Uint8Array, kind: GlobalPackage.Kind = "skill") =>
            packages.install({ kind, name, uploadedBy: "9000", organizations: [], archive }).pipe(Effect.flip)

          expect((yield* install("../evil", good))._tag).toBe("GlobalPackage.InvalidError")
          expect((yield* install("a", new Uint8Array([1, 2, 3])))._tag).toBe("GlobalPackage.InvalidError")
          expect((yield* install("a", zip([{ name: "README.md", data: "x" }])))._tag).toBe("GlobalPackage.InvalidError")
          expect((yield* install("a", good, "plugin"))._tag).toBe("GlobalPackage.InvalidError")
          expect((yield* install("mine", good))._tag).toBe("GlobalPackage.ConflictError")
          expect((yield* packages.remove("skill", "mine").pipe(Effect.flip))._tag).toBe("GlobalPackage.NotFoundError")
          expect(yield* Effect.promise(() => Bun.file(path.join(tmp.path, "config", "skills", "mine", "SKILL.md")).text())).toBe("hand made")
        }),
        tmp.path,
      )
    }),
  )
})
