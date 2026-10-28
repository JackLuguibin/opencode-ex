import { FileSystem, type ArchiveEntry } from "@opencode/core/filesystem"
import { FileWatch } from "@opencode/core/filesystem/file-watch"
import { Location } from "@opencode/core/location"
import { RelativePath } from "@opencode/core/schema"
import { Identity } from "@opencode/core/identity"
import { FileNotFoundError, InvalidRequestError, ServiceUnavailableError } from "@opencode/protocol/errors"
import { Effect, Option, Stream } from "effect"
import { HttpServerRequest, HttpServerResponse } from "effect/http"
import { HttpApiBuilder } from "effect/http-api"
import path from "path"
import { Api } from "../api"
import { accessFor } from "../access"
import { ServerAuth } from "../auth"
import { response } from "../location"
import { insideOrganization } from "../owned-project"
import { zip, type ZipEntry } from "../zip"

export const FileSystemHandler = HttpApiBuilder.group(Api, "server.fs", (handlers) =>
  Effect.gen(function* () {
    const fileWatch = yield* FileWatch.Service
    const identity = yield* Identity.Service
    const config = yield* ServerAuth.Config
    // Absolute paths reach outside the location, so signed-in users are held to their organization's directory.
    const allowed = Effect.fnUntraced(function* (input: string | undefined, options?: { readonly exclusive?: boolean }) {
      const request = yield* HttpServerRequest.HttpServerRequest
      const access = yield* accessFor(request, config, identity)
      const location = yield* Location.Service
      return yield* insideOrganization(path.resolve(location.directory, input ?? "."), access, identity, options)
    })
    return handlers
      .handleRaw("fs.read", (ctx) =>
        Effect.gen(function* () {
          const path = yield* decodeRequestPath(ctx.request.url)
          const fs = yield* FileSystem.Service
          const file = yield* fs
            .read({ path })
            .pipe(
              Effect.mapError(
                (error) => new FileNotFoundError({ path: error.path, message: `File not found: ${error.path}` }),
              ),
            )
          return serveFile(ctx.request, file)
        }),
      )
      .handleRaw("fs.archive", (ctx) =>
        Effect.gen(function* () {
          const filesystem = yield* FileSystem.Service
          const listing = yield* filesystem.archive({ path: ctx.query.path, paths: ctx.query.paths }).pipe(
            Effect.mapError(
              (error) => new FileNotFoundError({ path: error.path, message: `Directory not found: ${error.path}` }),
            ),
          )
          const entries: ZipEntry[] = []
          for (const entry of listing.entries) {
            if (entry.kind === "directory") {
              entries.push({ name: entry.name })
              continue
            }
            const bytes = yield* readArchiveFile(filesystem, entry)
            if (!bytes) continue
            entries.push({ name: entry.name, bytes })
          }
          return HttpServerResponse.uint8Array(zip(entries), {
            contentType: "application/zip",
            headers: {
              "cache-control": "no-cache, no-transform",
              "content-disposition": contentDisposition(listing.filename),
            },
          })
        }),
      )
      .handle("fs.list", (ctx) =>
        response(
          Effect.gen(function* () {
            if (!(yield* allowed(ctx.query.path)))
              return yield* new FileNotFoundError({ path: ctx.query.path ?? ".", message: `Directory not found: ${ctx.query.path ?? "."}` })
            const fs = yield* FileSystem.Service
            return yield* fs
              .list(ctx.query)
              .pipe(
                Effect.mapError(
                  (error) => new FileNotFoundError({ path: error.path, message: `Directory not found: ${error.path}` }),
                ),
              )
          }),
        ),
      )
      .handle("fs.find", (ctx) =>
        response(
          Effect.gen(function* () {
            const fs = yield* FileSystem.Service
            return yield* fs.find(ctx.query)
          }),
        ),
      )
      .handle("fs.write", (ctx) =>
        response(
          Effect.gen(function* () {
            if (!(yield* allowed(ctx.query.path, { exclusive: true })))
              return yield* new InvalidRequestError({ message: "Files can only be written inside your organization directory", field: "path" })
            const fs = yield* FileSystem.Service
            return yield* fs.write({ path: ctx.query.path, data: ctx.payload })
          }),
        ),
      )
      .handle("fs.mkdir", (ctx) =>
        response(
          Effect.gen(function* () {
            if (!(yield* allowed(ctx.query.path, { exclusive: true })))
              return yield* new InvalidRequestError({ message: "Folders can only be created inside your organization directory", field: "path" })
            const fs = yield* FileSystem.Service
            return yield* fs.mkdir({ path: ctx.query.path })
          }),
        ),
      )
      .handle("fs.watch", (ctx) =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.Service
          const location = yield* Location.Service
          // Same confinement as read: the file must exist inside the location.
          yield* fs
            .read({ path: RelativePath.make(ctx.payload.path) })
            .pipe(
              Effect.mapError(
                (error) => new FileNotFoundError({ path: error.path, message: `File not found: ${error.path}` }),
              ),
            )
          yield* fileWatch
            .watch({
              location: { directory: location.directory, workspaceID: location.workspaceID },
              file: path.resolve(location.directory, ctx.payload.path),
            })
            .pipe(
              Effect.mapError(
                (error) => new ServiceUnavailableError({ message: error.message, service: "filewatcher" }),
              ),
            )
        }),
      )
      .handle("fs.unwatch", (ctx) =>
        Effect.gen(function* () {
          const location = yield* Location.Service
          yield* fileWatch.unwatch({
            location: { directory: location.directory, workspaceID: location.workspaceID },
            file: path.resolve(location.directory, ctx.payload.path),
          })
        }),
      )
  }),
)

function readArchiveFile(filesystem: FileSystem.Interface, entry: Extract<ArchiveEntry, { kind: "file" }>) {
  return Effect.gen(function* () {
    const file = yield* filesystem
      .read({ path: entry.path })
      .pipe(Effect.catchTag("FileSystem.NotFoundError", () => Effect.succeed(undefined)))
    if (!file) return
    const parts = yield* Stream.runCollect(file.stream()).pipe(Effect.orDie)
    const bytes = new Uint8Array(Array.from(parts).reduce((sum, part) => sum + part.byteLength, 0))
    let at = 0
    for (const part of parts) {
      bytes.set(part, at)
      at += part.byteLength
    }
    return bytes
  })
}

function contentDisposition(filename: string) {
  const ascii = filename.replace(/[^\x20-\x7E]/g, "_").replace(/["\\]/g, "_")
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`
}

function decodeRequestPath(url: string) {
  const raw = new URL(url, "http://localhost").pathname.slice(13)
  return Effect.try({
    try: () => RelativePath.make(decodeURIComponent(raw)),
    catch: () => new FileNotFoundError({ path: raw, message: `File not found: ${raw}` }),
  })
}

function serveFile(request: HttpServerRequest.HttpServerRequest, file: FileSystem.File) {
  const etag = `W/"${file.size.toString(16)}-${Option.match(file.mtime, {
    onNone: () => "0",
    onSome: (mtime) => mtime.getTime().toString(16),
  })}"`
  const lastModified = Option.getOrUndefined(Option.map(file.mtime, (mtime) => mtime.toUTCString()))
  // Clients must revalidate after agent edits; no-transform keeps compression from changing Content-Length.
  const validators = {
    "cache-control": "no-cache, no-transform",
    etag,
    ...(lastModified === undefined ? {} : { "last-modified": lastModified }),
  }
  if (isNotModified(request, etag, lastModified)) return HttpServerResponse.empty({ status: 304, headers: validators })

  const rangeHeader = request.method === "GET" ? request.headers["range"] : undefined
  const range =
    rangeHeader !== undefined && matchesIfRange(request.headers["if-range"], etag, lastModified)
      ? parseRange(rangeHeader, file.size)
      : undefined
  if (range === "unsatisfiable")
    return HttpServerResponse.empty({
      status: 416,
      headers: { "accept-ranges": "bytes", "content-range": `bytes */${file.size}` },
    })

  const offset = range?.start ?? 0
  const length = range === undefined ? file.size : range.end - range.start + 1
  return HttpServerResponse.stream(length === 0 ? Stream.empty : file.stream({ offset, bytesToRead: length }), {
    status: range === undefined ? 200 : 206,
    contentLength: length,
    headers: {
      ...validators,
      "accept-ranges": "bytes",
      "content-type": file.mime,
      ...(range === undefined ? {} : { "content-range": `bytes ${range.start}-${range.end}/${file.size}` }),
    },
  })
}

function isNotModified(request: HttpServerRequest.HttpServerRequest, etag: string, lastModified: string | undefined) {
  const ifNoneMatch = request.headers["if-none-match"]
  if (ifNoneMatch !== undefined)
    return ifNoneMatch.split(",").some((tag) => tag.trim() === "*" || stripWeak(tag) === stripWeak(etag))
  const ifModifiedSince = request.headers["if-modified-since"]
  return (
    ifModifiedSince !== undefined &&
    lastModified !== undefined &&
    Date.parse(lastModified) <= Date.parse(ifModifiedSince)
  )
}

function matchesIfRange(ifRange: string | undefined, etag: string, lastModified: string | undefined) {
  if (ifRange === undefined) return true
  if (/^\s*(w\/)?"/i.test(ifRange)) return stripWeak(ifRange) === stripWeak(etag)
  return lastModified !== undefined && Date.parse(ifRange) === Date.parse(lastModified)
}

function stripWeak(etag: string) {
  return etag.trim().replace(/^w\//i, "")
}

function parseRange(header: string, size: number) {
  const match = /^bytes=\s*(\d*)\s*-\s*(\d*)\s*$/i.exec(header.trim())
  if (match === null || (match[1] === "" && match[2] === "")) return undefined
  if (match[1] === "") {
    const suffix = Number(match[2])
    if (suffix === 0 || size === 0) return "unsatisfiable"
    return { start: Math.max(size - suffix, 0), end: size - 1 }
  }
  const start = Number(match[1])
  const end = match[2] === "" ? size - 1 : Number(match[2])
  if (start > end || start >= size) return "unsatisfiable"
  return { start, end: Math.min(end, size - 1) }
}
