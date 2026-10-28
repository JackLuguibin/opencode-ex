export * as GlobalPackage from "./global-package.js"

import { makeGlobalNode } from "@opencode/util/effect/app-node"
import { Global } from "@opencode/util/global"
import { Context, Data, Effect, Layer } from "effect"
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises"
import path from "node:path"
import { ZipArchive } from "./zip-archive.js"

/**
 * Skill and plugin packages that every organization can use, kept in the global config directory where skills and
 * plugins are already discovered. Only packages installed here carry a marker file, so packages someone placed in the
 * directory by hand are listed nowhere and can't be replaced or deleted through this module.
 */
export type Kind = "skill" | "plugin"

export interface Info {
  readonly kind: Kind
  readonly name: string
  readonly description: string
  readonly size: number
  readonly uploadedBy: string
  readonly uploadedAt: number
  /** Organizations the package is open to; every other organization can't see or use it. */
  readonly organizations: readonly string[]
}

export class InvalidError extends Data.TaggedError("GlobalPackage.InvalidError")<{ readonly reason: string }> {}
export class ConflictError extends Data.TaggedError("GlobalPackage.ConflictError")<{ readonly name: string }> {}
export class NotFoundError extends Data.TaggedError("GlobalPackage.NotFoundError")<{ readonly name: string }> {}

export const LIMITS = { archive: 20 * 1024 * 1024, files: 2000, bytes: 100 * 1024 * 1024 }

const MARKER = ".opencode-package.json"
const FOLDERS = { skill: "skills", plugin: "plugins" } as const
export const NAME = /^[a-z0-9][a-z0-9._-]{0,63}$/i

/** Scope and switch state are shared with MCP servers, which aren't packages on disk. */
export const key = (kind: Kind | "mcp", name: string) => `${kind}:${name}`

const listPackages = Effect.fn("GlobalPackage.list")(function* () {
  const global = yield* Global.Service
  const scope = yield* Effect.promise(() => readScope(global.data))
  const packages = yield* Effect.forEach(["skill", "plugin"] as const, (kind) =>
    Effect.promise(async () => {
      const root = path.join(global.config, FOLDERS[kind])
      const names = await readdir(root).catch(() => [] as string[])
      return (await Promise.all(names.map((name) => describe(kind, root, name, scope)))).filter(
        (item) => item !== undefined,
      )
    }),
  )
  return packages.flat().toSorted((a, b) => a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name))
})

const installPackage = Effect.fn("GlobalPackage.install")(function* (input: {
  readonly kind: Kind
  readonly name: string
  readonly uploadedBy: string
  readonly organizations: readonly string[]
  readonly archive: Uint8Array
}) {
  const global = yield* Global.Service
  if (!NAME.test(input.name)) return yield* new InvalidError({ reason: "Package names use letters, digits, dots, dashes and underscores" })
  if (input.archive.length > LIMITS.archive) return yield* new InvalidError({ reason: "Archive is too large" })
  const files = yield* Effect.try({
    try: () => stripRoot(ZipArchive.read(input.archive, LIMITS)),
    catch: (error) => new InvalidError({ reason: error instanceof Error ? error.message : "Invalid archive" }),
  })
  const required = input.kind === "skill" ? "SKILL.md" : "package.json"
  if (!files.some((file) => file.path === required))
    return yield* new InvalidError({ reason: `A ${input.kind} package needs a ${required} at its top level` })
  if (files.some((file) => file.path.split("/").some((part) => part === MARKER)))
    return yield* new InvalidError({ reason: "Archive can't contain package metadata" })

  const root = path.join(global.config, FOLDERS[input.kind])
  const target = path.join(root, input.name)
  const existing = yield* Effect.promise(() => marker(target))
  const occupied = yield* Effect.promise(() => stat(target).then(() => true, () => false))
  if (occupied && !existing) return yield* new ConflictError({ name: input.name })

  // Extract aside and swap in, so a failure never leaves a half-installed package where it would be discovered.
  yield* Effect.promise(async () => {
    const staging = path.join(root, `.staging-${input.name}-${Date.now()}`)
    await rm(staging, { recursive: true, force: true })
    for (const file of files) {
      const destination = path.join(staging, file.path)
      await mkdir(path.dirname(destination), { recursive: true })
      await writeFile(destination, file.data)
    }
    await writeFile(
      path.join(staging, MARKER),
      JSON.stringify({ kind: input.kind, uploadedBy: input.uploadedBy, uploadedAt: Date.now() }),
    )
    await rm(target, { recursive: true, force: true })
    await rename(staging, target)
    await writeScope(global.data, { ...(await readScope(global.data)), [key(input.kind, input.name)]: [...new Set(input.organizations)].toSorted() })
  })
  return (yield* Effect.promise(async () => describe(input.kind, root, input.name, await readScope(global.data))))!
})

const removePackage = Effect.fn("GlobalPackage.remove")(function* (kind: Kind, name: string) {
  const global = yield* Global.Service
  const target = path.join(global.config, FOLDERS[kind], name)
  if (!NAME.test(name) || !(yield* Effect.promise(() => marker(target)))) return yield* new NotFoundError({ name })
  yield* Effect.promise(async () => {
    await rm(target, { recursive: true, force: true })
    const { [key(kind, name)]: _removed, ...rest } = await readScope(global.data)
    await writeScope(global.data, rest)
  })
})

const setPackageScope = Effect.fn("GlobalPackage.setScope")(function* (
  kind: Kind,
  name: string,
  organizations: readonly string[],
) {
  const global = yield* Global.Service
  const target = path.join(global.config, FOLDERS[kind], name)
  if (!NAME.test(name) || !(yield* Effect.promise(() => marker(target)))) return yield* new NotFoundError({ name })
  yield* Effect.promise(async () =>
    writeScope(global.data, { ...(await readScope(global.data)), [key(kind, name)]: [...new Set(organizations)].toSorted() }),
  )
})

/** Packages an organization has switched off, as `kind:name`. */
const disabledPackages = Effect.fn("GlobalPackage.disabled")(function* (organizationID: string) {
  const global = yield* Global.Service
  return yield* Effect.promise(() => readDisabled(global.data, organizationID))
})

const scopeFile = (data: string) => path.join(data, "organization-packages", "scope.json")

export const readScope = async (data: string): Promise<Record<string, readonly string[]>> => {
  const raw = await readFile(scopeFile(data), "utf8").catch(() => undefined)
  if (!raw) return {}
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {}
    return Object.fromEntries(
      Object.entries(parsed).map(([name, value]) => [
        name,
        Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [],
      ]),
    )
  } catch {
    return {}
  }
}

export const writeScope = async (data: string, scope: Record<string, readonly string[]>) => {
  await mkdir(path.dirname(scopeFile(data)), { recursive: true })
  await writeFile(scopeFile(data), JSON.stringify(scope))
}

/**
 * Packages an organization must not load: those switched off by its admins and those never opened to it. A package
 * without a scope entry is open to nobody.
 */
export const readHidden = async (config: string, data: string, organizationID: string) => {
  const [scope, disabled] = await Promise.all([readScope(data), readDisabled(data, organizationID)])
  const hidden = new Set(disabled)
  for (const kind of ["skill", "plugin"] as const) {
    const root = path.join(config, FOLDERS[kind])
    for (const name of await readdir(root).catch(() => [] as string[])) {
      if (!(await marker(path.join(root, name)))) continue
      if (!scope[key(kind, name)]?.includes(organizationID)) hidden.add(key(kind, name))
    }
  }
  return hidden
}

export const stateFile = (data: string, organizationID: string) =>
  path.join(data, "organization-packages", `${organizationID}.json`)

export const readDisabled = async (data: string, organizationID: string) => {
  const raw = await readFile(stateFile(data, organizationID), "utf8").catch(() => undefined)
  if (!raw) return new Set<string>()
  try {
    const parsed: unknown = JSON.parse(raw)
    const items = parsed && typeof parsed === "object" && "disabled" in parsed ? parsed.disabled : []
    return new Set(Array.isArray(items) ? items.filter((item): item is string => typeof item === "string") : [])
  } catch {
    return new Set<string>()
  }
}

export const writeDisabled = async (data: string, organizationID: string, disabled: ReadonlySet<string>) => {
  const file = stateFile(data, organizationID)
  await mkdir(path.dirname(file), { recursive: true })
  await writeFile(file, JSON.stringify({ disabled: [...disabled].toSorted() }))
}

// Kept outside the organization's directory, which its members' commands can write.
const setPackageEnabled = Effect.fn("GlobalPackage.setEnabled")(function* (
  organizationID: string,
  kind: Kind,
  name: string,
  enabled: boolean,
) {
  const global = yield* Global.Service
  const target = path.join(global.config, FOLDERS[kind], name)
  if (!NAME.test(name) || !(yield* Effect.promise(() => marker(target)))) return yield* new NotFoundError({ name })
  // A package that isn't open to the organization doesn't exist as far as it is concerned.
  if (!(yield* Effect.promise(() => readScope(global.data)))[key(kind, name)]?.includes(organizationID))
    return yield* new NotFoundError({ name })
  yield* Effect.promise(async () => {
    const current = await readDisabled(global.data, organizationID)
    if (enabled) current.delete(key(kind, name))
    else current.add(key(kind, name))
    const file = stateFile(global.data, organizationID)
    await mkdir(path.dirname(file), { recursive: true })
    await writeFile(file, JSON.stringify({ disabled: [...current].toSorted() }))
  })
})

/** The managed package a skill or plugin directory belongs to, when it is one. */
export const owner = (config: string, target: string) => {
  for (const kind of ["skill", "plugin"] as const) {
    const relative = path.relative(path.join(config, FOLDERS[kind]), target)
    if (relative.startsWith("..") || path.isAbsolute(relative) || relative === "") continue
    return key(kind, relative.split(path.sep)[0])
  }
}

async function describe(
  kind: Kind,
  root: string,
  name: string,
  scope: Record<string, readonly string[]>,
): Promise<Info | undefined> {
  const directory = path.join(root, name)
  const meta = await marker(directory)
  if (!meta) return
  const description =
    kind === "skill"
      ? ((await readFile(path.join(directory, "SKILL.md"), "utf8").catch(() => "")).match(/^description:\s*(.+)$/m)?.[1]?.trim() ?? "")
      : await readFile(path.join(directory, "package.json"), "utf8").then(
          (text) => {
            const value: unknown = JSON.parse(text)
            return value && typeof value === "object" && "description" in value && typeof value.description === "string"
              ? value.description
              : ""
          },
          () => "",
        )
  return { kind, name, description, size: await size(directory), uploadedBy: meta.uploadedBy, uploadedAt: meta.uploadedAt, organizations: scope[key(kind, name)] ?? [] }
}

async function marker(directory: string) {
  const raw = await readFile(path.join(directory, MARKER), "utf8").catch(() => undefined)
  if (!raw) return
  try {
    const value: unknown = JSON.parse(raw)
    if (!value || typeof value !== "object") return
    const uploadedBy = "uploadedBy" in value && typeof value.uploadedBy === "string" ? value.uploadedBy : ""
    const uploadedAt = "uploadedAt" in value && typeof value.uploadedAt === "number" ? value.uploadedAt : 0
    return { uploadedBy, uploadedAt }
  } catch {
    return
  }
}

async function size(directory: string): Promise<number> {
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => [])
  const sizes = await Promise.all(
    entries.map((entry) =>
      entry.isDirectory()
        ? size(path.join(directory, entry.name))
        : stat(path.join(directory, entry.name)).then((info) => info.size, () => 0),
    ),
  )
  return sizes.reduce((total, item) => total + item, 0)
}

/** Archives often wrap everything in one folder; the package starts inside it. */
function stripRoot(entries: ZipArchive.Entry[]) {
  const first = entries[0]?.path.split("/")[0]
  const wrapped = !!first && entries.every((entry) => entry.path.includes("/") && entry.path.split("/")[0] === first)
  return wrapped ? entries.map((entry) => ({ ...entry, path: entry.path.slice(first.length + 1) })) : entries
}

export interface Interface {
  readonly list: () => Effect.Effect<Info[]>
  readonly install: (input: {
    readonly kind: Kind
    readonly name: string
    readonly uploadedBy: string
    readonly organizations: readonly string[]
    readonly archive: Uint8Array
  }) => Effect.Effect<Info, InvalidError | ConflictError>
  /** Sets the organizations a package is open to. */
  readonly setScope: (kind: Kind, name: string, organizations: readonly string[]) => Effect.Effect<void, NotFoundError>
  readonly remove: (kind: Kind, name: string) => Effect.Effect<void, NotFoundError>
  readonly disabled: (organizationID: string) => Effect.Effect<ReadonlySet<string>>
  readonly setEnabled: (
    organizationID: string,
    kind: Kind,
    name: string,
    enabled: boolean,
  ) => Effect.Effect<void, NotFoundError>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/GlobalPackage") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const global = yield* Global.Service
    const provide = <A, E>(effect: Effect.Effect<A, E, Global.Service>) =>
      effect.pipe(Effect.provideService(Global.Service, global))
    return Service.of({
      list: () => provide(listPackages()),
      install: (input) => provide(installPackage(input)),
      remove: (kind, name) => provide(removePackage(kind, name)),
      setScope: (kind, name, organizations) => provide(setPackageScope(kind, name, organizations)),
      disabled: (organizationID) => provide(disabledPackages(organizationID)),
      setEnabled: (organizationID, kind, name, enabled) =>
        provide(setPackageEnabled(organizationID, kind, name, enabled)),
    })
  }),
)

export const node = makeGlobalNode({ service: Service, layer, deps: [Global.node] })
