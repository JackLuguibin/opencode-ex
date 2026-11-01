export * as SharedMcp from "./shared-mcp.js"

import { Mcp } from "@opencode/schema/mcp"
import { makeGlobalNode } from "@opencode/util/effect/app-node"
import { Global } from "@opencode/util/global"
import { Context, Data, Effect, Layer, Schema } from "effect"
import { readFile } from "node:fs/promises"
import path from "node:path"
import { GlobalPackage } from "./global-package.js"

/**
 * MCP servers a platform admin defines once for the organizations they are opened to. They are kept in the data
 * directory, outside every organization's directory: remote headers and server environments often hold secrets that
 * members must never read, so listings only describe a server and never return those values.
 */
export interface Entry {
  /** What routes and scope entries call it: unique across the platform. */
  readonly name: string
  /** What people see; another organization may use the same one. */
  readonly label: string
  readonly type: "local" | "remote"
  /** What the server is: its URL, or its command line. Secret values are not part of it. */
  readonly target: string
  readonly createdBy: string
  readonly createdAt: number
  /** The organization whose admin created it; unset for a platform admin's, which only a platform admin can change. */
  readonly owner?: string
  readonly organizations: readonly string[]
}

export type Input =
  | { readonly type: "remote"; readonly url: string; readonly headers?: Readonly<Record<string, string>> }
  | {
      readonly type: "local"
      readonly command: readonly string[]
      readonly environment?: Readonly<Record<string, string>>
    }

export class InvalidError extends Data.TaggedError("SharedMcp.InvalidError")<{ readonly reason: string }> {}
export class ConflictError extends Data.TaggedError("SharedMcp.ConflictError")<{ readonly name: string }> {}
export class NotFoundError extends Data.TaggedError("SharedMcp.NotFoundError")<{ readonly name: string }> {}

type Stored = { config: Mcp.ServerConfig; createdBy: string; createdAt: number; owner?: string; label?: string }

const file = (data: string) => path.join(data, "organization-packages", "mcp.json")
const key = (name: string) => GlobalPackage.key("mcp", name)

const read = async (data: string): Promise<Record<string, Stored>> => {
  const raw = await readFile(file(data), "utf8").catch(() => undefined)
  if (!raw) return {}
  try {
    const parsed: unknown = JSON.parse(raw)
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, Stored>) : {}
  } catch {
    return {}
  }
}

const write = async (data: string, servers: Record<string, Stored>) => {
  await GlobalPackage.writeAtomic(file(data), JSON.stringify(servers))
}

/** The servers an organization may run: open to it, and not switched off by its admins. */
export const readUsable = async (data: string, organizationID: string) => {
  const [servers, scope, disabled] = await Promise.all([
    read(data),
    GlobalPackage.readScope(data),
    GlobalPackage.readDisabled(data, organizationID),
  ])
  return Object.entries(servers)
    .filter(([name]) => scope[key(name)]?.includes(organizationID) && !disabled.has(key(name)))
    .map(([name, stored]) => ({ name: stored.label ?? name, config: stored.config }))
    .toSorted((a, b) => a.name.localeCompare(b.name))
}

export const stateDirectory = (data: string) => path.dirname(file(data))

const describe = (name: string, stored: Stored, scope: Record<string, readonly string[]>): Entry => ({
  name,
  label: stored.label ?? name,
  type: stored.config.type,
  target: stored.config.type === "remote" ? stored.config.url : stored.config.command.join(" "),
  createdBy: stored.createdBy,
  createdAt: stored.createdAt,
  owner: stored.owner,
  organizations: scope[key(name)] ?? [],
})

export interface Interface {
  readonly list: () => Effect.Effect<Entry[]>
  readonly save: (input: {
    readonly name: string
    readonly server: Input
    readonly createdBy: string
    readonly owner?: string
    readonly organizations: readonly string[]
  }) => Effect.Effect<Entry, InvalidError | ConflictError>
  readonly remove: (name: string) => Effect.Effect<void, NotFoundError>
  readonly setScope: (name: string, organizations: readonly string[]) => Effect.Effect<void, NotFoundError>
  readonly setEnabled: (organizationID: string, name: string, enabled: boolean) => Effect.Effect<void, NotFoundError>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SharedMcp") {}

const decode = Schema.decodeUnknownSync(Mcp.ServerConfig)

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const global = yield* Global.Service
    const data = global.data

    const list = Effect.fn("SharedMcp.list")(function* () {
      const [servers, scope] = yield* Effect.promise(() => Promise.all([read(data), GlobalPackage.readScope(data)]))
      return Object.entries(servers)
        .map(([name, stored]) => describe(name, stored, scope))
        .toSorted((a, b) => a.name.localeCompare(b.name))
    })

    const save = Effect.fn("SharedMcp.save")(function* (input: {
      readonly name: string
      readonly server: Input
      readonly createdBy: string
      readonly owner?: string
      readonly organizations: readonly string[]
    }) {
      const id = GlobalPackage.identify(input.name, input.owner)
      if (!GlobalPackage.NAME.test(input.name) || !GlobalPackage.NAME.test(id))
        return yield* new InvalidError({ reason: "Names use letters, digits, dots, dashes and underscores" })
      const config = yield* Effect.try({
        try: () => build(input.server),
        catch: (error) => new InvalidError({ reason: error instanceof Error ? error.message : "Invalid server" }),
      })
      const servers = yield* Effect.promise(() => read(data))
      // An organization can't reuse the name of a platform server, which could be open to it as well.
      if (servers[id] || (input.owner && servers[input.name])) return yield* new ConflictError({ name: input.name })
      yield* Effect.promise(async () => {
        await write(data, {
          ...servers,
          [id]: { config, createdBy: input.createdBy, createdAt: Date.now(), owner: input.owner, label: input.name },
        })
        await GlobalPackage.writeScope(data, {
          ...(await GlobalPackage.readScope(data)),
          [key(id)]: [...new Set(input.organizations)].toSorted(),
        })
      })
      return (yield* list()).find((entry) => entry.name === id)!
    })

    const requireServer = (name: string) =>
      Effect.promise(() => read(data)).pipe(
        Effect.flatMap((servers) => (servers[name] ? Effect.void : Effect.fail(new NotFoundError({ name })))),
      )

    return Service.of({
      list,
      save,
      remove: Effect.fn("SharedMcp.remove")(function* (name: string) {
        yield* requireServer(name)
        yield* Effect.promise(async () => {
          const { [name]: _removed, ...rest } = await read(data)
          await write(data, rest)
          const { [key(name)]: _scope, ...scope } = await GlobalPackage.readScope(data)
          await GlobalPackage.writeScope(data, scope)
        })
      }),
      setScope: Effect.fn("SharedMcp.setScope")(function* (name: string, organizations: readonly string[]) {
        yield* requireServer(name)
        yield* Effect.promise(async () =>
          GlobalPackage.writeScope(data, {
            ...(await GlobalPackage.readScope(data)),
            [key(name)]: [...new Set(organizations)].toSorted(),
          }),
        )
      }),
      setEnabled: Effect.fn("SharedMcp.setEnabled")(function* (organizationID: string, name: string, enabled: boolean) {
        yield* requireServer(name)
        if (!(yield* Effect.promise(() => GlobalPackage.readScope(data)))[key(name)]?.includes(organizationID))
          return yield* new NotFoundError({ name })
        yield* Effect.promise(async () => {
          const current = await GlobalPackage.readDisabled(data, organizationID)
          if (enabled) current.delete(key(name))
          else current.add(key(name))
          await GlobalPackage.writeDisabled(data, organizationID, current)
        })
      }),
    })
  }),
)

export const node = makeGlobalNode({ service: Service, layer, deps: [Global.node] })

/** Only the fields the admin console offers are kept, so nothing else (a `cwd`, say) rides along. */
function build(input: Input): Mcp.ServerConfig {
  if (input.type === "remote") {
    const url = URL.canParse(input.url) ? new URL(input.url) : undefined
    if (!url || (url.protocol !== "http:" && url.protocol !== "https:")) throw new Error("Enter an http or https URL")
    return decode({ type: "remote", url: input.url.trim(), ...(hasKeys(input.headers) ? { headers: input.headers } : {}) })
  }
  const command = input.command.map((part) => part.trim()).filter(Boolean)
  if (command.length === 0) throw new Error("Enter a command")
  return decode({
    type: "local",
    command,
    ...(hasKeys(input.environment) ? { environment: input.environment } : {}),
  })
}

const hasKeys = (value: Readonly<Record<string, string>> | undefined): value is Readonly<Record<string, string>> =>
  !!value && Object.keys(value).length > 0
