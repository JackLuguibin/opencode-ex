export * as FileSystem from "./filesystem.js"

import { makeLocationNode } from "@opencode/util/effect/app-node"
import path from "path"
import { Context, Effect, Layer, type Option, type PlatformError, Schema, type Stream } from "effect"
import { FSUtil } from "@opencode/util/fs-util"
import { Location } from "./location.js"
import { AbsolutePath, PositiveInt, RelativePath } from "./schema.js"
import { FileSystemSearch } from "./filesystem/search.js"
import { Entry, FileSystem, FindInput, Write } from "@opencode/schema/filesystem"
export { Entry, Match, Submatch } from "@opencode/schema/filesystem"

export interface ReadInput {
  readonly path: RelativePath
}

export interface WriteInput {
  /** Absolute, or relative to the location directory. */
  readonly path: string
  readonly data: Uint8Array
}

export class NotFoundError extends Schema.TaggedError<NotFoundError>()("FileSystem.NotFoundError", {
  path: RelativePath,
}) {}

export class DirectoryNotFoundError extends Schema.TaggedError<DirectoryNotFoundError>()(
  "FileSystem.DirectoryNotFoundError",
  {
    directory: AbsolutePath,
    cause: Schema.Defect(),
  },
) {
  override get message() {
    return `Directory not found: ${this.directory}`
  }
}

export class DirectoryAccessDeniedError extends Schema.TaggedError<DirectoryAccessDeniedError>()(
  "FileSystem.DirectoryAccessDeniedError",
  {
    directory: AbsolutePath,
    cause: Schema.Defect(),
  },
) {
  override get message() {
    return `Access denied to directory: ${this.directory}`
  }
}

export const Content = Schema.Struct({
  uri: Schema.String,
  name: Schema.String.pipe(Schema.optional),
  content: Schema.String,
  encoding: Schema.Literals(["utf8", "base64"]),
  mime: Schema.String,
}).annotate({ identifier: "FileSystem.Content" })
export type Content = typeof Content.Type

export interface ListInput {
  readonly path?: string
}

export { FindInput, Write }

export const DEFAULT_SEARCH_LIMIT = 100
export const DEFAULT_SEARCH_TIMEOUT_MS = 30_000

export class GlobInput extends Schema.Class<GlobInput>("FileSystem.GlobInput")({
  pattern: Schema.String,
  path: Schema.optionalKey(RelativePath),
  hidden: Schema.optionalKey(Schema.Boolean),
  limit: Schema.optionalKey(PositiveInt),
}) {}

export class GrepInput extends Schema.Class<GrepInput>("FileSystem.GrepInput")({
  pattern: Schema.String,
  path: Schema.optionalKey(RelativePath),
  include: Schema.optionalKey(Schema.String),
  literal: Schema.optionalKey(Schema.Boolean),
  caseSensitive: Schema.optionalKey(Schema.Boolean),
  limit: Schema.optionalKey(PositiveInt),
}) {}

export const Event = FileSystem.Event

export interface File {
  readonly mime: string
  readonly size: number
  readonly mtime: Option.Option<Date>
  readonly stream: (options?: {
    readonly offset?: number
    readonly bytesToRead?: number
  }) => Stream.Stream<Uint8Array, PlatformError.PlatformError>
}

export type ArchiveEntry =
  | { readonly kind: "file"; readonly name: string; readonly path: RelativePath }
  | { readonly kind: "directory"; readonly name: string }

export interface ArchiveListing {
  readonly filename: string
  readonly entries: ReadonlyArray<ArchiveEntry>
}

export interface Interface {
  readonly read: (input: ReadInput) => Effect.Effect<File, NotFoundError>
  /** Fails with `NotFoundError` when the path is missing or is not a directory. */
  readonly list: (input?: ListInput) => Effect.Effect<Entry[], NotFoundError>
  readonly find: (input: FindInput) => Effect.Effect<Entry[]>
  /** Writes a file at an absolute path or one relative to the location; not confined to it. */
  readonly write: (input: WriteInput) => Effect.Effect<Write>
  /** Creates a directory and any missing parents at an absolute path or one relative to the location; not confined to it. */
  readonly mkdir: (input: { readonly path: string }) => Effect.Effect<Write>
  /** Deletes a file or directory tree at an absolute path or one relative to the location; not confined to it. A missing path succeeds. */
  readonly remove: (input: { readonly path: string }) => Effect.Effect<Write>
  /**
   * Copies a file or directory tree from inside the location to an absolute path or one relative to the location, creating
   * parent directories and replacing what is there. Fails with `NotFoundError` when the source is missing or outside the
   * location; the destination is not confined to it.
   */
  readonly copy: (input: { readonly from: RelativePath; readonly to: string }) => Effect.Effect<Write, NotFoundError>
  /**
   * Lists one directory inside the location for a zip download. Fails when the path is missing, not a directory, or
   * outside the location. `paths`, when set, keeps only those location-relative files and directories.
   */
  readonly archive: (input?: {
    readonly path?: string
    readonly paths?: readonly string[]
  }) => Effect.Effect<ArchiveListing, NotFoundError>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/FileSystem") {}

const baseLayer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const fs = yield* FSUtil.Service
    const location = yield* Location.Service
    const search = yield* FileSystemSearch.Service
    // Workspace-placed directories exist only inside the workspace, so a host
    // realpath probe at boot consults the wrong filesystem and would block
    // construction on servers without a matching local directory. Treat the
    // configured directory as canonical; local placements keep symlink
    // canonicalization. This skip is boot-only: resolve/read/list below still
    // access the host filesystem per operation (tracked in #44568).
    const root = location.workspaceID
      ? location.directory
      : yield* fs.realPath(location.directory).pipe(
          // Linux realpath succeeds on an unreadable directory, so probe readability explicitly.
          Effect.tap((real) => fs.access(real, { readable: true })),
          Effect.catch((cause): Effect.Effect<never, DirectoryNotFoundError | DirectoryAccessDeniedError> => {
            if (cause.reason._tag === "NotFound")
              return Effect.fail(new DirectoryNotFoundError({ directory: location.directory, cause }))
            if (FSUtil.isAccessDenied(cause))
              return Effect.fail(new DirectoryAccessDeniedError({ directory: location.directory, cause }))
            return Effect.die(cause)
          }),
        )
    const resolve = Effect.fnUntraced(function* (input: RelativePath) {
      if (input.includes("\u0000")) return yield* Effect.fail(new NotFoundError({ path: input }))
      const absolute = path.resolve(location.directory, input)
      if (!FSUtil.contains(location.directory, absolute)) return yield* Effect.fail(new NotFoundError({ path: input }))
      const real = yield* fs.realPath(absolute).pipe(
        Effect.catchReason(
          "PlatformError",
          "NotFound",
          () => Effect.fail(new NotFoundError({ path: input })),
          (_, error) => Effect.die(error),
        ),
      )
      if (!FSUtil.contains(root, real)) return yield* Effect.fail(new NotFoundError({ path: input }))
      return { absolute, real, directory: location.directory }
    })
    return Service.of({
      find: search.find,
      read: Effect.fn("FileSystem.read")(function* (input) {
        const target = yield* resolve(input.path)
        const info = yield* fs.stat(target.real).pipe(
          Effect.catchReason(
            "PlatformError",
            "NotFound",
            () => Effect.fail(new NotFoundError({ path: input.path })),
            (_, error) => Effect.die(error),
          ),
        )
        if (info.type !== "File") return yield* Effect.fail(new NotFoundError({ path: input.path }))
        return {
          mime: FSUtil.mimeType(target.real),
          size: Number(info.size),
          mtime: info.mtime,
          stream: (options) => fs.stream(target.real, options),
        }
      }),
      list: Effect.fn("FileSystem.list")(function* (input = {}) {
        // Navigation can leave the cwd without activating another Location.
        const directory = path.resolve(location.directory, input.path ?? ".")
        const missing = new NotFoundError({ path: RelativePath.make(input.path ?? ".") })
        const info = yield* fs.stat(directory).pipe(
          Effect.catchReason(
            "PlatformError",
            "NotFound",
            () => Effect.fail(missing),
            (_, error) => Effect.die(error),
          ),
        )
        if (info.type !== "Directory") return yield* missing
        return yield* fs.readDirectoryEntries(directory).pipe(
          Effect.orDie,
          Effect.map((items) =>
            items
              .flatMap((item) => {
                if (item.type !== "file" && item.type !== "directory") return []
                const absolute = path.join(directory, item.name)
                const relative = path.relative(location.directory, absolute) || "."
                return [
                  Entry.make({
                    path: RelativePath.make(relative + (item.type === "directory" ? path.sep : "")),
                    type: item.type,
                  }),
                ]
              })
              .sort((a, b) => (a.type === b.type ? a.path.localeCompare(b.path) : a.type === "directory" ? -1 : 1)),
          ),
        )
      }),
      // Unlike read, write reaches outside the location so clients can stage files in the
      // server tmp directory, which the model is already told to prefer and permitted to access.
      write: Effect.fn("FileSystem.write")(function* (input) {
        const target = path.resolve(location.directory, input.path)
        yield* fs.writeWithDirs(target, input.data).pipe(Effect.orDie)
        return Write.make({ path: AbsolutePath.make(target) })
      }),
      mkdir: Effect.fn("FileSystem.mkdir")(function* (input) {
        const target = path.resolve(location.directory, input.path)
        yield* fs.ensureDir(target).pipe(Effect.orDie)
        return Write.make({ path: AbsolutePath.make(target) })
      }),
      remove: Effect.fn("FileSystem.remove")(function* (input) {
        const target = path.resolve(location.directory, input.path)
        yield* fs.remove(target, { recursive: true, force: true }).pipe(Effect.orDie)
        return Write.make({ path: AbsolutePath.make(target) })
      }),
      copy: Effect.fn("FileSystem.copy")(function* (input) {
        const source = yield* resolve(input.from)
        const target = path.resolve(location.directory, input.to)
        yield* fs.ensureDir(path.dirname(target)).pipe(Effect.orDie)
        yield* fs.copy(source.real, target, { overwrite: true }).pipe(Effect.orDie)
        return Write.make({ path: AbsolutePath.make(target) })
      }),
      archive: Effect.fn("FileSystem.archive")(function* (input = {}) {
        const requested = RelativePath.make((input.path ?? ".").replace(/[\\/]+$/, "") || ".")
        const target = yield* resolve(requested)
        const info = yield* fs.stat(target.real).pipe(
          Effect.catchReason(
            "PlatformError",
            "NotFound",
            () => Effect.fail(new NotFoundError({ path: requested })),
            (_, error) => Effect.die(error),
          ),
        )
        if (info.type !== "Directory") return yield* Effect.fail(new NotFoundError({ path: requested }))
        const rawName = requested === "." ? path.basename(location.directory) : path.basename(requested)
        const folder = !rawName || rawName === "." || rawName === ".." ? "download" : rawName
        const fromLocation = path.relative(location.directory, target.real)
        const base = !fromLocation || fromLocation === "." ? "" : fromLocation.split(path.sep).join("/")
        return yield* walkArchive({
          fs,
          root,
          real: target.real,
          folder,
          base,
          include: includeSet(input.paths),
        })
      }),
    })
  }),
)

const walkArchive = Effect.fnUntraced(function* (input: {
  fs: FSUtil.Interface
  root: string
  real: string
  folder: string
  base: string
  include: ReadonlySet<string> | undefined
}) {
  const entries: ArchiveEntry[] = []
  const seen = new Set<string>([input.real])
  // Symbolic links are omitted, matching directory listing. Following one could leave the location.
  const visit = (realDir: string, zipPrefix: string, locationPrefix: string): Effect.Effect<void> =>
    Effect.gen(function* () {
      if (coverage(locationPrefix, input.include) === "none") return
      entries.push({ kind: "directory", name: `${zipPrefix}/` })
      const children = yield* input.fs.readDirectoryEntries(realDir).pipe(Effect.orDie)
      const sorted = children
        .flatMap((item) => (item.type === "file" || item.type === "directory" ? [item] : []))
        .toSorted((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === "directory" ? -1 : 1))
      for (const child of sorted) {
        const relative = locationPrefix ? `${locationPrefix}/${child.name}` : child.name
        if (coverage(relative, input.include) === "none") continue
        const real = yield* input.fs.realPath(path.join(realDir, child.name)).pipe(
          Effect.catchReason(
            "PlatformError",
            "NotFound",
            () => Effect.void,
            (_, error) => Effect.die(error),
          ),
        )
        if (!real || !FSUtil.contains(input.root, real)) continue
        const name = `${zipPrefix}/${child.name}`
        if (child.type === "file") {
          entries.push({ kind: "file", name, path: RelativePath.make(relative) })
          continue
        }
        if (seen.has(real)) continue
        seen.add(real)
        yield* visit(real, name, relative)
      }
    })
  yield* visit(input.real, input.folder, input.base)
  return { filename: `${input.folder}.zip`, entries }
})

function includeSet(paths: readonly string[] | undefined) {
  if (!paths) return

  const include = new Set<string>()

  for (const path of paths) {
    const normalized = path.replaceAll("\\", "/").replace(/^\/+|\/+$/g, "")

    if (normalized) include.add(normalized)
  }

  return include
}

/** Whether a location-relative path is wholly selected, only contains a selection, or is left out. */
function coverage(relative: string, include: ReadonlySet<string> | undefined): "all" | "some" | "none" {
  if (!include) return "all"
  if (relative === "") return include.size === 0 ? "none" : "some"
  if (include.has(relative)) return "all"

  for (const path of include) {
    if (path.startsWith(`${relative}/`)) return "some"
    if (relative.startsWith(`${path}/`)) return "all"
  }

  return "none"
}

export const node = makeLocationNode({
  service: Service,
  layer: baseLayer,
  deps: [FSUtil.node, Location.node, FileSystemSearch.node],
})
