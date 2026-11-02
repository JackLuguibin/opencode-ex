import { FileSystem } from "@opencode/schema/filesystem"
import { Location } from "@opencode/schema/location"
import { NonNegativeInt, PositiveInt } from "@opencode/schema/schema"
import { Schema } from "effect"
import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema, OpenApi } from "effect/http-api"
import {
  ConflictError,
  FileNotFoundError,
  ForbiddenError,
  InsufficientStorageError,
  InvalidRequestError,
  ServiceUnavailableError,
} from "../errors.js"
import { LocationQuery, locationQueryOpenApi } from "./location.js"

const ListQuery = Schema.Struct({
  ...LocationQuery.fields,
  path: Schema.String.pipe(Schema.optional).annotate({
    description: "An absolute path or a path relative to the requested location. Defaults to the location directory.",
  }),
})

const WriteQuery = Schema.Struct({
  ...LocationQuery.fields,
  path: Schema.String.annotate({
    description:
      "An absolute path or a path relative to the requested location. Missing parent directories are created.",
  }),
})

const CopyQuery = Schema.Struct({
  ...LocationQuery.fields,
  path: Schema.String.annotate({ description: "The file or directory to copy, relative to the requested location." }),
  to: Schema.String.annotate({
    description:
      "An absolute destination path or one relative to the requested location. Missing parent directories are created and an existing destination is replaced.",
  }),
})

const UploadCreate = Schema.Struct({
  path: Schema.String.annotate({
    description: "The file to create, absolute or relative to the requested location. Missing parent directories are created.",
  }),
  size: NonNegativeInt.annotate({ description: "The total size of the file in bytes." }),
  onConflict: Schema.Literals(["fail", "replace", "rename"]).pipe(Schema.optional).annotate({
    description: "What to do when the target exists. fail (default) answers 409, rename keeps both under a new name.",
  }),
})

const UploadParams = { uploadID: Schema.String }

const UploadChunkQuery = Schema.Struct({
  ...LocationQuery.fields,
  index: NonNegativeInt.annotate({ description: "The zero-based chunk number." }),
})

/** The state of one resumable upload: what the server has, and how to send the rest. */
const UploadState = Schema.Struct({
  uploadID: Schema.String,
  path: Schema.String,
  size: NonNegativeInt,
  chunkSize: PositiveInt,
  /** Chunk numbers the server already holds. */
  received: Schema.Array(NonNegativeInt),
}).annotate({ identifier: "FileSystem.Upload" })

const UploadDone = Schema.Struct({
  path: Schema.String,
  size: NonNegativeInt,
}).annotate({ identifier: "FileSystem.UploadDone" })

const WatchPayload = Schema.Struct({
  path: Schema.String.annotate({ description: "A file path relative to the requested location." }),
})

const ArchiveQuery = Schema.Struct({
  ...LocationQuery.fields,
  path: ListQuery.fields.path,
  paths: Schema.optional(Schema.ArrayEnsure(Schema.String)).annotate({
    description:
      "Location-relative files and directories to include. A directory path includes everything inside it. When omitted, the whole directory is included.",
  }),
})

const ReadQuery = Schema.Struct({
  ...LocationQuery.fields,
  download: Schema.optional(Schema.Literals(["true"])).annotate({
    description:
      "Set when the file is being saved rather than shown. Such a read is refused for file types the organization does not allow members to download.",
  }),
})

const FindQuery = Schema.Struct({
  ...LocationQuery.fields,
  query: FileSystem.FindInput.fields.query,
  type: FileSystem.FindInput.fields.type,
  limit: Schema.NumberFromString.pipe(Schema.decodeTo(PositiveInt), Schema.optional),
})

export const FileSystemGroup = HttpApiGroup.make("server.fs")
  .add(
    HttpApiEndpoint.get("fs.read", "/api/fs/read/*", {
      query: ReadQuery,
      success: Schema.Uint8Array.pipe(HttpApiSchema.asUint8Array()),
      error: [FileNotFoundError, ForbiddenError],
    })
      .annotateMerge(locationQueryOpenApi)
      .annotateMerge(
        OpenApi.annotations({
          identifier: "fs.read",
          summary: "Read file",
          description:
            "Stream one file relative to the requested location with ETag, Last-Modified, and single-range HTTP Range support (206 Partial Content, 416 Range Not Satisfiable, and 304 Not Modified; multi-range and malformed Range headers fall back to 200).",
        }),
      ),
  )
  .add(
    HttpApiEndpoint.get("fs.list", "/api/fs/list", {
      query: ListQuery,
      success: Location.response(Schema.Array(FileSystem.Entry)),
      error: FileNotFoundError,
    })
      .annotateMerge(locationQueryOpenApi)
      .annotateMerge(
        OpenApi.annotations({
          identifier: "fs.list",
          summary: "List directory",
          description:
            "List direct children using an absolute path or a path relative to the requested location, including parents and siblings outside its directory. Entry paths remain relative to the requested location; listing does not switch locations.",
        }),
      ),
  )
  .add(
    HttpApiEndpoint.get("fs.archive", "/api/fs/archive", {
      query: ArchiveQuery,
      success: Schema.Uint8Array.pipe(HttpApiSchema.asUint8Array()),
      error: [FileNotFoundError, ForbiddenError],
    })
      .annotateMerge(locationQueryOpenApi)
      .annotateMerge(
        OpenApi.annotations({
          identifier: "fs.archive",
          summary: "Download directory",
          description:
            "Download one directory as a zip archive. The path is a directory relative to the requested location, or the location itself when omitted. paths limits the archive to those files and directories. Symbolic links are skipped. A path that is missing, not a directory, or outside the location is not found. Files of a type the organization does not allow members to download are left out.",
        }),
      ),
  )
  .add(
    HttpApiEndpoint.get("fs.find", "/api/fs/find", {
      query: FindQuery,
      success: Location.response(Schema.Array(FileSystem.Entry)),
    })
      .annotateMerge(locationQueryOpenApi)
      .annotateMerge(
        OpenApi.annotations({
          identifier: "fs.find",
          summary: "Find files",
          description: "Find recursively ranked filesystem entries relative to the requested location.",
        }),
      ),
  )
  .add(
    HttpApiEndpoint.post("fs.write", "/api/experimental/fs/write", {
      query: WriteQuery,
      payload: Schema.Uint8Array.pipe(HttpApiSchema.asUint8Array()),
      success: Location.response(FileSystem.Write),
      error: InvalidRequestError,
    })
      .annotateMerge(locationQueryOpenApi)
      .annotateMerge(
        OpenApi.annotations({
          identifier: "experimental.fs.write",
          summary: "Write file",
          description:
            "Write the raw request body to an absolute path or a path relative to the requested location, creating parent directories, and return the resolved absolute path. Unlike read, the target is not confined to the location, but signed-in users can only write inside their organization's directory. Experimental: may change without compatibility guarantees.",
        }),
      ),
  )
  .add(
    HttpApiEndpoint.post("fs.mkdir", "/api/experimental/fs/mkdir", {
      query: WriteQuery,
      success: Location.response(FileSystem.Write),
      error: InvalidRequestError,
    })
      .annotateMerge(locationQueryOpenApi)
      .annotateMerge(
        OpenApi.annotations({
          identifier: "experimental.fs.mkdir",
          summary: "Create directory",
          description:
            "Create a directory and any missing parents at an absolute path or a path relative to the requested location, and return the resolved absolute path. Succeeds when the directory already exists. Unlike read, the target is not confined to the location, but signed-in users can only write inside their organization's directory. Experimental: may change without compatibility guarantees.",
        }),
      ),
  )
  .add(
    HttpApiEndpoint.delete("fs.delete", "/api/experimental/fs/delete", {
      query: WriteQuery,
      success: Location.response(FileSystem.Write),
      error: InvalidRequestError,
    })
      .annotateMerge(locationQueryOpenApi)
      .annotateMerge(
        OpenApi.annotations({
          identifier: "experimental.fs.delete",
          summary: "Delete file or directory",
          description:
            "Delete a file, or a directory and everything inside it, at an absolute path or a path relative to the requested location, and return the resolved absolute path. Succeeds when the path does not exist. The location directory itself cannot be deleted. Unlike read, the target is not confined to the location, but signed-in users can only delete inside their organization's directory. Experimental: may change without compatibility guarantees.",
        }),
      ),
  )
  .add(
    HttpApiEndpoint.post("fs.copy", "/api/experimental/fs/copy", {
      query: CopyQuery,
      success: Location.response(FileSystem.Write),
      error: [FileNotFoundError, InvalidRequestError],
    })
      .annotateMerge(locationQueryOpenApi)
      .annotateMerge(
        OpenApi.annotations({
          identifier: "experimental.fs.copy",
          summary: "Copy file or directory",
          description:
            "Copy a file, or a directory and everything inside it, from the requested location to an absolute path or a path relative to the requested location, and return the resolved destination. The source must be inside the location; the destination is not confined to it, but signed-in users can only copy into their organization's directory, and into the organization's shared space only within their own subfolder. Experimental: may change without compatibility guarantees.",
        }),
      ),
  )
  .add(
    HttpApiEndpoint.post("fs.watch", "/api/experimental/fs/watch", {
      query: LocationQuery,
      payload: WatchPayload,
      success: HttpApiSchema.NoContent,
      error: [FileNotFoundError, ServiceUnavailableError],
    })
      .annotateMerge(locationQueryOpenApi)
      .annotateMerge(
        OpenApi.annotations({
          identifier: "experimental.fs.watch",
          summary: "Watch file",
          description:
            "Watch one file relative to the requested location for 24 hours, publishing filesystem.changed on that location when it changes. Watching an already watched file resets its expiry. Paths follow read confinement. Experimental: may change without compatibility guarantees.",
        }),
      ),
  )
  .add(
    HttpApiEndpoint.delete("fs.unwatch", "/api/experimental/fs/watch", {
      query: LocationQuery,
      payload: WatchPayload,
      success: HttpApiSchema.NoContent,
    })
      .annotateMerge(locationQueryOpenApi)
      .annotateMerge(
        OpenApi.annotations({
          identifier: "experimental.fs.unwatch",
          summary: "Unwatch file",
          description:
            "Stop watching one file relative to the requested location. Experimental: may change without compatibility guarantees.",
        }),
      ),
  )
  .add(
    HttpApiEndpoint.post("fs.upload.create", "/api/experimental/fs/upload", {
      query: LocationQuery,
      payload: UploadCreate,
      success: Location.response(UploadState),
      error: [InvalidRequestError, ConflictError, InsufficientStorageError],
    })
      .annotateMerge(locationQueryOpenApi)
      .annotateMerge(
        OpenApi.annotations({
          identifier: "experimental.fs.upload.create",
          summary: "Start upload",
          description:
            "Start a resumable chunked upload of one file, for files too large to send in a single request. Send each chunk with upload.chunk, then finish with upload.complete; the target only appears once the upload completes. Subject to the same confinement as write. Experimental: may change without compatibility guarantees.",
        }),
      ),
  )
  .add(
    HttpApiEndpoint.put("fs.upload.chunk", "/api/experimental/fs/upload/:uploadID/chunk", {
      params: UploadParams,
      query: UploadChunkQuery,
      payload: Schema.Uint8Array.pipe(HttpApiSchema.asUint8Array()),
      success: HttpApiSchema.NoContent,
      error: [InvalidRequestError, FileNotFoundError],
    })
      .annotateMerge(locationQueryOpenApi)
      .annotateMerge(
        OpenApi.annotations({
          identifier: "experimental.fs.upload.chunk",
          summary: "Upload chunk",
          description:
            "Store one chunk of an upload. Every chunk but the last is exactly the upload's chunkSize. Sending a chunk again replaces it. Experimental: may change without compatibility guarantees.",
        }),
      ),
  )
  .add(
    HttpApiEndpoint.get("fs.upload.get", "/api/experimental/fs/upload/:uploadID", {
      params: UploadParams,
      query: LocationQuery,
      success: Location.response(UploadState),
      error: FileNotFoundError,
    })
      .annotateMerge(locationQueryOpenApi)
      .annotateMerge(
        OpenApi.annotations({
          identifier: "experimental.fs.upload.get",
          summary: "Get upload",
          description:
            "Read which chunks of an upload the server holds, to resume it. Experimental: may change without compatibility guarantees.",
        }),
      ),
  )
  .add(
    HttpApiEndpoint.post("fs.upload.complete", "/api/experimental/fs/upload/:uploadID/complete", {
      params: UploadParams,
      query: LocationQuery,
      success: Location.response(UploadDone),
      error: [InvalidRequestError, ConflictError, FileNotFoundError],
    })
      .annotateMerge(locationQueryOpenApi)
      .annotateMerge(
        OpenApi.annotations({
          identifier: "experimental.fs.upload.complete",
          summary: "Finish upload",
          description:
            "Check that every chunk arrived, move the file to its target in one step. Experimental: may change without compatibility guarantees.",
        }),
      ),
  )
  .add(
    HttpApiEndpoint.delete("fs.upload.cancel", "/api/experimental/fs/upload/:uploadID", {
      params: UploadParams,
      query: LocationQuery,
      success: HttpApiSchema.NoContent,
      error: FileNotFoundError,
    })
      .annotateMerge(locationQueryOpenApi)
      .annotateMerge(
        OpenApi.annotations({
          identifier: "experimental.fs.upload.cancel",
          summary: "Cancel upload",
          description:
            "Discard an upload and the chunks received so far. Experimental: may change without compatibility guarantees.",
        }),
      ),
  )
  .annotateMerge(
    OpenApi.annotations({
      title: "filesystem",
      description: "Experimental location-scoped filesystem routes.",
    }),
  )
