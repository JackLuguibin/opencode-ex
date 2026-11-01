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

// Operators can move every organization out of the data directory.
const withRoot = async <A>(root: string, run: () => Promise<A> | A) => {
  const before = process.env.OPENCODE_ORGANIZATIONS_ROOT
  process.env.OPENCODE_ORGANIZATIONS_ROOT = root
  try {
    return await run()
  } finally {
    if (before === undefined) delete process.env.OPENCODE_ORGANIZATIONS_ROOT
    else process.env.OPENCODE_ORGANIZATIONS_ROOT = before
  }
}

describe("OrganizationSandbox.organizations", () => {
  test("follows OPENCODE_ORGANIZATIONS_ROOT", async () => {
    expect(OrganizationSandbox.organizations("/data")).toBe("/data/organizations")
    await withRoot("/mnt/orgs", () => {
      expect(OrganizationSandbox.organizations("/data")).toBe("/mnt/orgs")
      expect(OrganizationSandbox.root("/data", "/mnt/orgs/org_a/project")).toBe("/mnt/orgs/org_a")
      expect(OrganizationSandbox.root("/data", "/data/organizations/org_a/project")).toBeUndefined()
    })
  })
})

// The wrapper needs an operating system sandbox: sandbox-exec on macOS, or bubblewrap where the kernel lets it start.
const sandboxed =
  process.platform === "darwin" ||
  (process.platform === "linux" && !!Bun.which("bwrap") && Bun.spawnSync(["bwrap", "--ro-bind", "/", "/", "true"]).exitCode === 0)

describe.skipIf(!sandboxed)("OrganizationSandbox.wrap", () => {
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

  test("reads but never changes the organization's own configuration", async () => {
    await using tmp = await tmpdir()
    const own = path.join(tmp.path, "data", "organizations", "org_a")
    await fs.mkdir(path.join(own, ".opencode"), { recursive: true })
    await fs.writeFile(path.join(own, ".opencode", "opencode.json"), "{}")
    const confinement = { root: own, data: path.join(tmp.path, "data"), home: path.join(tmp.path, "home") }
    const run = (command: string) => {
      const wrapped = OrganizationSandbox.wrap(confinement, "/bin/sh", ["-c", command])
      return Bun.spawnSync([wrapped.command, ...wrapped.args], { cwd: own })
    }

    expect(run("cat .opencode/opencode.json").stdout.toString()).toBe("{}")
    expect(run("mkdir -p .opencode/plugins && echo x > .opencode/plugins/a.ts").exitCode).not.toBe(0)
    expect(run("echo x > .opencode/opencode.json").exitCode).not.toBe(0)
    expect(await Bun.file(path.join(own, ".opencode", "plugins", "a.ts")).exists()).toBe(false)
    expect(run("echo x > project.txt").exitCode).toBe(0)
  })

  test("hides the server's own environment from commands", async () => {
    await using tmp = await tmpdir()
    const own = path.join(tmp.path, "data", "organizations", "org_a")
    await fs.mkdir(own, { recursive: true })
    const confinement = { root: own, data: path.join(tmp.path, "data"), home: path.join(tmp.path, "home") }
    process.env.OPENCODE_TEST_DATABASE_URL = "postgres://secret"
    try {
      const wrapped = OrganizationSandbox.wrap(confinement, "/bin/sh", ["-c", "env"])
      const result = Bun.spawnSync([wrapped.command, ...wrapped.args], { cwd: own })
      const printed = result.stdout.toString()
      expect(printed).not.toContain("OPENCODE_TEST_DATABASE_URL")
      expect(printed).toContain("PATH=")
      expect(OrganizationSandbox.unwrap([wrapped.command, ...wrapped.args])).toEqual(["/bin/sh", "-c", "env"])
    } finally {
      delete process.env.OPENCODE_TEST_DATABASE_URL
    }
  })

  test("keeps other organizations closed when the root is outside the data directory", async () => {
    await using tmp = await tmpdir()
    const root = path.join(tmp.path, "orgs")
    const own = path.join(root, "org_a")
    const other = path.join(root, "org_b")
    await fs.mkdir(path.join(own, "proj"), { recursive: true })
    await fs.mkdir(other, { recursive: true })
    await fs.writeFile(path.join(own, "proj", "a.txt"), "mine")
    await fs.writeFile(path.join(other, "b.txt"), "theirs")
    const confinement = { root: own, data: path.join(tmp.path, "data"), home: path.join(tmp.path, "home") }
    await withRoot(root, () => {
      const wrapped = OrganizationSandbox.wrap(confinement, "/bin/sh", ["-c", `cat a.txt; cat ${path.join(other, "b.txt")}`])
      const result = Bun.spawnSync([wrapped.command, ...wrapped.args], { cwd: path.join(own, "proj") })
      expect(result.stdout.toString()).toBe("mine")
      expect(result.exitCode).not.toBe(0)
    })
  })
})
