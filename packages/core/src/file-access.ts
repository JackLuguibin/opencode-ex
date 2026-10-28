export * as FileAccess from "./file-access.js"

import { makeLocationNode } from "@opencode/util/effect/app-node"
import { FSUtil } from "@opencode/util/fs-util"
import { Global } from "@opencode/util/global"
import { Array, Context, Effect, Layer, Schema } from "effect"
import { realpathSync } from "fs"
import path from "path"
import { Environment } from "./environment/index.js"
import { Location } from "./location.js"
import { OrganizationSandbox } from "./organization-sandbox.js"
import { Permission } from "./permission.js"
import { Project } from "./project.js"
import { AbsolutePath } from "./schema.js"
import type { SessionErrors } from "./session/error.js"
import type { Tool } from "./tool.js"

export const Kind = Schema.Literals(["file", "directory"])
export type Kind = typeof Kind.Type

export const ResolveInput = Schema.Struct({
  path: Schema.String,
  /** Selects the external approval boundary; it does not validate the target type. */
  kind: Kind.pipe(Schema.optional),
})
export type ResolveInput = typeof ResolveInput.Type

export interface ExternalDirectoryAuthorization {
  readonly action: "external_directory"
  /** Lexical directory used as the external approval boundary. */
  readonly directory: AbsolutePath
  readonly resource: string
  readonly save: string
}

export interface Target {
  readonly absolute: AbsolutePath
  /** Location-relative for internal paths, absolute for external paths. */
  readonly resource: string
  readonly externalDirectory?: ExternalDirectoryAuthorization
}

export type Invocation = Pick<Tool.Context, "sessionID" | "agent" | "messageID" | "id">

export interface ReadOptions {
  /** A target already authorized by this invocation, used for filename recovery. */
  readonly siblingOf: Target
}

export interface Interface {
  /** Resolve a lexical path and its permission resources, without requesting approval. */
  readonly resolve: (input: ResolveInput) => Effect.Effect<Target, Environment.Failed>
  /** Approve external directories in one batch, preserving first-seen resource order. */
  readonly authorizeExternal: (
    targets: readonly Target[],
    context: Invocation,
    metadata?: Permission.AssertInput["metadata"],
  ) => Effect.Effect<void, Permission.Error | SessionErrors.NotFoundError>
  /** Resolve a read target and obtain external-directory approval before read approval. */
  readonly authorizeRead: (
    file: string,
    context: Invocation,
    options?: ReadOptions,
  ) => Effect.Effect<Target, Environment.Failed | Permission.Error | SessionErrors.NotFoundError>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/FileAccess") {}

/** Expand a leading ~ and normalize Windows shell paths before lexical resolution. */
export const resolvePath = (directory: string, input: string, home = Global.Path.home) => {
  const normalized = FSUtil.windowsPath(input)
  return path.resolve(
    directory,
    normalized === "~"
      ? home
      : normalized.startsWith("~/") || (process.platform === "win32" && normalized.startsWith("~\\"))
        ? path.join(home, normalized.slice(2))
        : normalized,
  )
}

/** Whether the real location of `target`, or of its nearest existing parent, is outside `root`. */
const escapes = (root: string, target: string) => {
  // Resolves the part that exists and keeps the rest as written.
  const real = (value: string): string => {
    try {
      return realpathSync(value)
    } catch {
      const parent = path.dirname(value)
      return parent === value ? value : path.join(real(parent), path.basename(value))
    }
  }
  return !FSUtil.contains(real(root), real(target))
}

const slash = (value: string) => value.replaceAll("\\", "/")
const invocation = (context: Invocation) => ({
  sessionID: context.sessionID,
  agent: context.agent,
  source: { type: "tool" as const, messageID: context.messageID, id: context.id },
})

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const { files } = yield* Environment.Service
    const exists = (file: string) => Environment.exists(files, file)
    const location = yield* Location.Service
    const permission = yield* Permission.Service
    const global = yield* Global.Service
    const confinement = OrganizationSandbox.root(global.data, location.directory)

    const resolve = Effect.fn("FileAccess.resolve")(function* (input: ResolveInput) {
      const absolute = AbsolutePath.make(resolvePath(location.directory, input.path))
      const worktree = path.resolve(location.project.directory)
      const internal =
        FSUtil.contains(location.directory, absolute) ||
        (worktree !== path.parse(worktree).root && FSUtil.contains(worktree, absolute))
      // A symlink inside an organization can point anywhere, so the real location decides, not the lexical one.
      if (internal && !(confinement && escapes(confinement, absolute))) {
        return {
          absolute,
          resource: slash(path.relative(location.directory, absolute) || "."),
        } satisfies Target
      }
      const type =
        input.kind ??
        (yield* Environment.typeFollowing(files, absolute).pipe(
          Effect.catchTag("Environment.NotFound", () => Effect.undefined),
        ))
      const directory = AbsolutePath.make(type === "directory" ? absolute : path.dirname(absolute))
      return {
        absolute,
        resource: slash(absolute),
        externalDirectory: {
          action: "external_directory",
          directory,
          resource: slash(path.join(directory, "*")),
          save: slash(path.join((yield* Project.root({ exists }, directory)) ?? directory, "*")),
        },
      } satisfies Target
    })

    const authorizeExternal = Effect.fn("FileAccess.authorizeExternal")(function* (
      targets: readonly Target[],
      context: Invocation,
      metadata?: Permission.AssertInput["metadata"],
    ) {
      const external = Array.dedupeWith(
        targets.flatMap((target) => (target.externalDirectory ? [target.externalDirectory] : [])),
        (left, right) => left.resource === right.resource,
      )
      if (external.length === 0) return
      // Approval can't widen an organization's boundary: a member could otherwise approve their own escape.
      if (confinement) {
        const outside = external.filter((item) => escapes(confinement, item.directory))
        if (outside.length > 0)
          return yield* new Permission.BlockedError({
            rules: [],
            permission: "external_directory",
            resources: outside.map((item) => item.resource),
            reason: "Sessions in an organization can only access files inside the organization directory",
          })
        return
      }
      yield* permission.assert({
        action: "external_directory",
        resources: external.map((item) => item.resource),
        save: external.map((item) => item.save),
        ...(metadata === undefined ? {} : { metadata }),
        ...invocation(context),
      })
    })

    const authorizeRead = Effect.fn("FileAccess.authorizeRead")(function* (
      file: string,
      context: Invocation,
      options?: ReadOptions,
    ) {
      const target = yield* resolve({ path: file, kind: options ? "file" : undefined })
      const sibling = options && path.dirname(target.absolute) === path.dirname(options.siblingOf.absolute)

      // Filename recovery shares the directory approval, but checks the recovered file's own read rules.
      if (!sibling) yield* authorizeExternal([target], context)
      yield* permission.assert({
        action: "read",
        resources: [target.resource],
        save: ["*"],
        ...invocation(context),
      })
      return target
    })

    return Service.of({ resolve, authorizeExternal, authorizeRead })
  }),
)

export const node = makeLocationNode({
  service: Service,
  layer,
  deps: [Environment.node, Location.node, Permission.node, Global.node],
})
