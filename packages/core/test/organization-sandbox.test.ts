import { describe, expect, test } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { OrganizationSandbox } from "@opencode/core/organization-sandbox"
import { tmpdir } from "./fixture/tmpdir"

describe("OrganizationSandbox.root", () => {
  test("names the organization a directory belongs to", () => {
    expect(OrganizationSandbox.root("/data", "/data/organizations/org_a/project/src")).toBe("/data/organizations/org_a")
    expect(OrganizationSandbox.root("/data", "/data/organizations")).toBeUndefined()
    expect(OrganizationSandbox.root("/data", "/work/project")).toBeUndefined()
  })
})

// The wrapper needs an operating system sandbox, which is only available (and verifiable) on macOS here.
describe.skipIf(process.platform !== "darwin")("OrganizationSandbox.wrap", () => {
  test("keeps commands inside their organization directory", async () => {
    await using tmp = await tmpdir()
    const own = path.join(tmp.path, "data", "organizations", "org_a")
    const other = path.join(tmp.path, "data", "organizations", "org_b")
    await fs.mkdir(path.join(own, "proj"), { recursive: true })
    await fs.mkdir(other, { recursive: true })
    await fs.writeFile(path.join(own, "proj", "a.txt"), "mine")
    await fs.writeFile(path.join(other, "b.txt"), "theirs")
    await fs.symlink(other, path.join(own, "proj", "link"))
    const shared = path.join(tmp.path, "home", "config", "skills")
    await fs.mkdir(shared, { recursive: true })
    await fs.writeFile(path.join(shared, "SKILL.md"), "shared")
    const confinement = {
      root: own,
      data: path.join(tmp.path, "data"),
      home: path.join(tmp.path, "home"),
      readable: [shared],
    }
    const run = (command: string) => {
      const wrapped = OrganizationSandbox.wrap(confinement, "/bin/sh", ["-c", command])
      return Bun.spawnSync([wrapped.command, ...wrapped.args], { cwd: path.join(own, "proj") })
    }

    expect(run("cat a.txt").stdout.toString()).toBe("mine")
    expect(run(`cat ${path.join(other, "b.txt")}`).exitCode).not.toBe(0)
    expect(run("cat link/b.txt").exitCode).not.toBe(0)
    expect(run(`echo x > ${path.join(other, "w.txt")}`).exitCode).not.toBe(0)
    expect(await Bun.file(path.join(other, "w.txt")).exists()).toBe(false)
    // Shared skills can be read and run, never changed.
    expect(run(`cat ${path.join(shared, "SKILL.md")}`).stdout.toString()).toBe("shared")
    expect(run(`echo x > ${path.join(shared, "SKILL.md")}`).exitCode).not.toBe(0)
  })
})
