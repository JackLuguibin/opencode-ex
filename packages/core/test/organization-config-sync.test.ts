import { expect, test } from "bun:test"
import { mkdtemp, readFile, writeFile, mkdir, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { syncOrganizationConfig } from "../src/identity/config-sync"

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
