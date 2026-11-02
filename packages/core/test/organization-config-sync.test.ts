import { expect, test } from "bun:test"
import { mkdtemp, readFile, writeFile, mkdir, rm, symlink } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { GlobalPackage } from "../src/global-package"
import { globalConfigSignature, syncOrganizationConfig, syncOrganizations } from "../src/identity/config-sync"

async function setup() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "org-config-"))
  const global = path.join(dir, "global")
  const org = path.join(dir, "organizations", "org_1")
  await mkdir(global, { recursive: true })
  return { global, org, file: path.join(org, ".opencode", "opencode.json") }
}

const read = async (file: string) => JSON.parse(await readFile(file, "utf8"))

test("seeds a new organization from the global config", async () => {
  const t = await setup()
  await writeFile(path.join(t.global, "opencode.json"), JSON.stringify({ theme: "a", share: "manual" }))
  await syncOrganizationConfig(t.global, t.org)
  expect(await read(t.file)).toEqual({ theme: "a", share: "manual" })
})

test("global changes reach the organization except keys it edited", async () => {
  const t = await setup()
  const globalFile = path.join(t.global, "opencode.json")
  await writeFile(globalFile, JSON.stringify({ theme: "a", share: "manual", model: "x" }))
  await syncOrganizationConfig(t.global, t.org)
  await writeFile(t.file, JSON.stringify({ theme: "own", share: "manual", model: "x", extra: 1 }))
  await writeFile(globalFile, JSON.stringify({ theme: "b", share: "auto" }))
  await syncOrganizationConfig(t.global, t.org)
  expect(await read(t.file)).toEqual({ theme: "own", share: "auto", extra: 1 })
})

test("existing organization settings are not overwritten on first sync", async () => {
  const t = await setup()
  await mkdir(path.dirname(t.file), { recursive: true })
  await writeFile(t.file, JSON.stringify({ theme: "own" }))
  await writeFile(path.join(t.global, "opencode.json"), JSON.stringify({ theme: "a", share: "auto" }))
  await syncOrganizationConfig(t.global, t.org)
  expect(await read(t.file)).toEqual({ theme: "own", share: "auto" })
})

test("global skills and plugins are copied and follow later changes", async () => {
  const t = await setup()
  const skill = path.join(t.global, "skills", "review", "SKILL.md")
  await mkdir(path.dirname(skill), { recursive: true })
  await writeFile(skill, "v1")
  await mkdir(path.join(t.global, "plugins"), { recursive: true })
  await writeFile(path.join(t.global, "plugins", "a.js"), "a1")
  await mkdir(path.join(t.global, "node_modules", "x"), { recursive: true })
  await writeFile(path.join(t.global, "node_modules", "x", "i.js"), "x")
  await syncOrganizationConfig(t.global, t.org)
  const copy = path.join(t.org, ".opencode", "skills", "review", "SKILL.md")
  expect(await readFile(copy, "utf8")).toBe("v1")
  expect(await readFile(path.join(t.org, ".opencode", "plugins", "a.js"), "utf8")).toBe("a1")
  await expect(readFile(path.join(t.org, ".opencode", "node_modules", "x", "i.js"))).rejects.toThrow()

  await writeFile(skill, "v2")
  await writeFile(path.join(t.org, ".opencode", "plugins", "a.js"), "own")
  await writeFile(path.join(t.global, "plugins", "a.js"), "a2")
  await syncOrganizationConfig(t.global, t.org)
  expect(await readFile(copy, "utf8")).toBe("v2")
  expect(await readFile(path.join(t.org, ".opencode", "plugins", "a.js"), "utf8")).toBe("own")

  await rm(skill)
  await syncOrganizationConfig(t.global, t.org)
  await expect(readFile(copy)).rejects.toThrow()
})

test("packages hidden from an organization are not copied and are removed when hidden later", async () => {
  const t = await setup()
  for (const name of ["open", "closed"]) {
    await mkdir(path.join(t.global, "skills", name), { recursive: true })
    await writeFile(path.join(t.global, "skills", name, "SKILL.md"), name)
  }
  await syncOrganizationConfig(t.global, t.org, new Set(["skill:closed"]))
  const skills = path.join(t.org, ".opencode", "skills")
  expect(await readFile(path.join(skills, "open", "SKILL.md"), "utf8")).toBe("open")
  await expect(readFile(path.join(skills, "closed", "SKILL.md"))).rejects.toThrow()

  await syncOrganizationConfig(t.global, t.org, new Set(["skill:open"]))
  await expect(readFile(path.join(skills, "open", "SKILL.md"))).rejects.toThrow()
  expect(await readFile(path.join(skills, "closed", "SKILL.md"), "utf8")).toBe("closed")
})

async function platform() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "org-platform-"))
  const global = path.join(dir, "config")
  await mkdir(global, { recursive: true })
  for (const id of ["org_1", "org_2"]) await mkdir(path.join(dir, "organizations", id), { recursive: true })
  const skill = (id: string) => path.join(dir, "organizations", id, ".opencode", "skills", "demo", "SKILL.md")
  return { dir, global, skill }
}

test("syncing now follows several rounds of global skill changes for every organization", async () => {
  const t = await platform()
  const source = path.join(t.global, "skills", "demo")
  await mkdir(source, { recursive: true })
  const open = async (ids: string[]) =>
    GlobalPackage.writeScope(t.dir, { [GlobalPackage.key("skill", "demo")]: ids })
  await writeFile(path.join(source, GlobalPackage.MARKER), JSON.stringify({ kind: "skill", label: "demo" }))

  for (const round of ["one", "two", "three"]) {
    await writeFile(path.join(source, "SKILL.md"), round)
    await open(["org_1", "org_2"])
    expect(await syncOrganizations(t.global, t.dir)).toBe(2)
    expect(await readFile(t.skill("org_1"), "utf8")).toBe(round)
    expect(await readFile(t.skill("org_2"), "utf8")).toBe(round)
  }

  // Closing it to one organization takes it away from the other on the next sync.
  await open(["org_1"])
  await syncOrganizations(t.global, t.dir)
  expect(await readFile(t.skill("org_1"), "utf8")).toBe("three")
  await expect(readFile(t.skill("org_2"))).rejects.toThrow()

  // Syncing one organization leaves the others as they were.
  await writeFile(path.join(source, "SKILL.md"), "four")
  await open(["org_1", "org_2"])
  expect(await syncOrganizations(t.global, t.dir, "org_2")).toBe(1)
  expect(await readFile(t.skill("org_2"), "utf8")).toBe("four")
  expect(await readFile(t.skill("org_1"), "utf8")).toBe("three")
  expect(await syncOrganizations(t.global, t.dir, "org_missing")).toBe(0)

  // Removing the package removes the copies.
  await rm(source, { recursive: true })
  await syncOrganizations(t.global, t.dir)
  await expect(readFile(t.skill("org_1"))).rejects.toThrow()
  await expect(readFile(t.skill("org_2"))).rejects.toThrow()
})

test("syncing now carries the global MCP config to every organization", async () => {
  const t = await platform()
  const config = path.join(t.global, "opencode.json")
  for (const url of ["https://a.example/mcp", "https://b.example/mcp"]) {
    await writeFile(config, JSON.stringify({ mcp: { docs: { type: "remote", url } } }))
    await syncOrganizations(t.global, t.dir)
    for (const id of ["org_1", "org_2"])
      expect((await read(path.join(t.dir, "organizations", id, ".opencode", "opencode.json"))).mcp.docs.url).toBe(url)
  }
  await writeFile(config, JSON.stringify({}))
  await syncOrganizations(t.global, t.dir)
  expect((await read(path.join(t.dir, "organizations", "org_1", ".opencode", "opencode.json"))).mcp).toBeUndefined()
})

test("a skill a script links into the global config reaches the organizations", async () => {
  const t = await platform()
  const outside = path.join(t.dir, "elsewhere", "linked")
  await mkdir(path.join(outside, "refs"), { recursive: true })
  await writeFile(path.join(outside, "SKILL.md"), "linked one")
  await writeFile(path.join(outside, "refs", "a.md"), "ref")
  await mkdir(path.join(t.global, "skills"), { recursive: true })
  await symlink(outside, path.join(t.global, "skills", "linked"))
  expect(await globalConfigSignature(t.global, t.dir)).toContain("skills/linked/SKILL.md")
  await syncOrganizations(t.global, t.dir)
  const copy = (id: string, file: string) => path.join(t.dir, "organizations", id, ".opencode", "skills", "linked", file)
  expect(await readFile(copy("org_1", "SKILL.md"), "utf8")).toBe("linked one")
  expect(await readFile(copy("org_2", "refs/a.md"), "utf8")).toBe("ref")

  await writeFile(path.join(outside, "SKILL.md"), "linked two")
  await syncOrganizations(t.global, t.dir)
  expect(await readFile(copy("org_1", "SKILL.md"), "utf8")).toBe("linked two")
})
