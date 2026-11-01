import { describe, expect } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { Effect } from "effect"
import { ChildProcess } from "effect/process"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { OrganizationSandbox } from "@opencode/core/organization-sandbox"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { Path } from "@opencode/util/global"
import { AppProcess } from "@opencode/util/process"
import { testEffect } from "./lib/effect"

const it = testEffect(AppNodeBuilder.build(LayerNode.group([AppProcess.node]), []))

// The wrapper needs an operating system sandbox: sandbox-exec on macOS, or bubblewrap where the kernel lets it start.
const sandboxed =
  process.platform === "darwin" ||
  (process.platform === "linux" && !!Bun.which("bwrap") && Bun.spawnSync(["bwrap", "--ro-bind", "/", "/", "true"]).exitCode === 0)

describe.skipIf(!sandboxed)(
  "processes the server starts in an organization directory",
  () => {
    it.live("are confined like a terminal", () =>
      Effect.gen(function* () {
        const processes = yield* AppProcess.Service
        const organizations = OrganizationSandbox.organizations(Path.data)
        const own = path.join(organizations, `spawn_test_${process.pid}`)
        const outside = path.join(path.dirname(Path.data), `spawn_outside_${process.pid}.txt`)
        yield* Effect.promise(async () => {
          await fs.mkdir(path.join(own, "proj"), { recursive: true })
          await fs.writeFile(outside, "secret")
        })
        process.env.OPENCODE_TEST_DATABASE_URL = "postgres://secret"
        const run = (script: string) =>
          processes.run(ChildProcess.make("/bin/sh", ["-c", script], { cwd: path.join(own, "proj"), extendEnv: true }))
        const result = yield* Effect.all({
          env: run("env"),
          read: run(`cat ${outside}`),
          write: run(`echo x > ${outside}.new`),
          own: run("echo ok > a.txt && cat a.txt"),
        }).pipe(
          Effect.ensuring(
            Effect.promise(async () => {
              delete process.env.OPENCODE_TEST_DATABASE_URL
              await fs.rm(own, { recursive: true, force: true })
              await fs.rm(outside, { force: true })
              await fs.rm(`${outside}.new`, { force: true })
            }),
          ),
        )
        expect(result.env.stdout.toString()).not.toContain("OPENCODE_TEST_DATABASE_URL")
        expect(result.read.exitCode).not.toBe(0)
        expect(result.write.exitCode).not.toBe(0)
        expect(result.own.stdout.toString().trim()).toBe("ok")
      }),
    )
  },
)
