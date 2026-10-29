import { createHash } from "node:crypto"
import { isDeepStrictEqual } from "node:util"
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises"
import path from "node:path"
import { applyEdits, modify, parse } from "jsonc-parser"
import { GlobalPackage } from "../global-package.js"

const NAMES = ["opencode.json", "opencode.jsonc"]
const BASELINE = ".global-sync.json"
const FILES_BASELINE = ".global-sync-files.json"
// Installed packages and their manifests belong to the directory that was installed into; dotfiles are local state.
const SKIPPED = new Set(["node_modules", "package.json", "package-lock.json", "bun.lock", "bun.lockb", ...NAMES])
const FORMATTING = { tabSize: 2, insertSpaces: true }

/** The folder inside an organization's directory that holds the configuration only that organization loads. */
export function organizationConfigDirectory(organizationRoot: string) {
  return path.join(organizationRoot, ".opencode")
}

/**
 * Brings an organization's own config up to date with the global one. Each top-level key follows the global value
 * while the organization has not changed it since the last sync; a key the organization edited keeps its value. The
 * last synced global values are kept beside the config so those two cases can be told apart.
 */
export async function syncOrganizationConfig(
  globalDirectory: string,
  organizationRoot: string,
  hidden: ReadonlySet<string> = new Set(),
) {
  const global = await readConfig(globalDirectory)
  const directory = organizationConfigDirectory(organizationRoot)
  await mkdir(directory, { recursive: true })
  const target = (await readConfig(directory)) ?? {
    file: path.join(directory, NAMES[0]),
    text: "{}\n",
    value: {} as Record<string, unknown>,
    exists: false,
  }
  const baselineFile = path.join(directory, BASELINE)
  const baseline = await readFile(baselineFile, "utf8").then(
    (text): Record<string, unknown> => parse(text) ?? {},
    () => undefined,
  )
  const next = global?.value ?? {}
  // Without a baseline every key the organization already has counts as its own, so nothing it set is overwritten.
  const previous = baseline ?? {}
  const keys = new Set([...Object.keys(next), ...Object.keys(previous)])
  let text = target.text
  const current: Record<string, unknown> = { ...target.value }
  for (const key of keys) {
    if (isDeepStrictEqual(next[key], previous[key])) continue
    // The organization changed this key itself.
    if (key in current && !isDeepStrictEqual(current[key], previous[key])) continue
    text = applyEdits(text, modify(text, [key], next[key], { formattingOptions: FORMATTING }))
    if (next[key] === undefined) delete current[key]
    else current[key] = next[key]
  }
  if (text !== target.text || !target.exists) await writeFile(target.file, text.endsWith("\n") ? text : `${text}\n`)
  const synced = JSON.stringify(next, null, 2)
  if (synced !== (await readFile(baselineFile, "utf8").catch(() => undefined))) await writeFile(baselineFile, synced)
  await syncFiles(globalDirectory, directory, hidden)
}

/** Skills, plugins, agents, commands and the like: files follow the global copy until the organization changes them. */
async function syncFiles(globalDirectory: string, directory: string, hidden: ReadonlySet<string>) {
  const baselineFile = path.join(directory, FILES_BASELINE)
  const baseline: Record<string, string> = await readFile(baselineFile, "utf8").then(
    (text) => JSON.parse(text),
    () => ({}),
  )
  const global = new Map(await Promise.all((await listFiles(globalDirectory, "")).map(async (name) => [name, await hash(path.join(globalDirectory, name))] as const)))
  const next: Record<string, string> = {}
  for (const name of new Set([...global.keys(), ...Object.keys(baseline)])) {
    const target = path.join(directory, name)
    // A package the organization switched off, or was never given, is not copied and any copy it has is removed.
    const owner = GlobalPackage.owner(globalDirectory, path.join(globalDirectory, name))
    const wanted = owner && hidden.has(owner) ? undefined : global.get(name)
    const current = await hash(target)
    const previous = baseline[name]
    // The organization edited or created this file itself.
    const own = current !== undefined && current !== previous && current !== wanted
    if (wanted === previous || own) {
      if (own && wanted !== undefined) next[name] = previous ?? wanted
      else if (wanted !== undefined) next[name] = wanted
      continue
    }
    if (wanted === undefined) await rm(target, { force: true })
    else {
      await mkdir(path.dirname(target), { recursive: true })
      await writeFile(target, await readFile(path.join(globalDirectory, name)))
      next[name] = wanted
    }
  }
  const text = JSON.stringify(next, null, 2)
  if (text !== (await readFile(baselineFile, "utf8").catch(() => undefined))) await writeFile(baselineFile, text)
}

async function listFiles(root: string, relative: string): Promise<string[]> {
  const entries = await readdir(path.join(root, relative), { withFileTypes: true }).catch(() => [])
  const nested = await Promise.all(
    entries
      .filter((entry) => !entry.name.startsWith(".") && !(relative === "" && SKIPPED.has(entry.name)) && entry.name !== "node_modules")
      .map((entry) => {
        const name = path.join(relative, entry.name)
        return entry.isDirectory() ? listFiles(root, name) : entry.isFile() || entry.isSymbolicLink() ? [name] : []
      }),
  )
  return nested.flat()
}

async function hash(file: string) {
  const bytes = await readFile(file).catch(() => undefined)
  return bytes && createHash("sha1").update(bytes).digest("hex")
}

/** Organization directories on this layer, which each get their own config. */
export async function organizationRoots(dataDirectory: string) {
  const root = path.join(dataDirectory, "organizations")
  const entries = await readdir(root, { withFileTypes: true }).catch(() => [])
  return entries.filter((entry) => entry.isDirectory()).map((entry) => path.join(root, entry.name))
}

/** The global config, its skills, plugins and other files, and which packages each organization may use, to tell whether any changed. */
export async function globalConfigSignature(globalDirectory: string, dataDirectory: string) {
  const packages = path.join(dataDirectory, "organization-packages")
  const state = await Promise.all(
    (await readdir(packages).catch(() => [])).toSorted().map(async (name) => `${name}:${await hash(path.join(packages, name))}`),
  )
  const found = await readConfig(globalDirectory)
  const files = await Promise.all(
    (await listFiles(globalDirectory, "")).map(async (name) => `${name}:${await hash(path.join(globalDirectory, name))}`),
  )
  return `${found ? `${found.file}\n${found.text}` : ""}\n${files.join("\n")}\n${state.join("\n")}`
}

async function readConfig(directory: string) {
  for (const name of NAMES.toReversed()) {
    const file = path.join(directory, name)
    const text = await readFile(file, "utf8").catch(() => undefined)
    if (text === undefined) continue
    const value = parse(text)
    return { file, text, value: isRecord(value) ? value : {}, exists: true }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
