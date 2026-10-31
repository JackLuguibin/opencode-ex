import fs from "node:fs/promises"
import path from "node:path"
import { expect } from "bun:test"
import { Effect } from "effect"
import { tmpdirScoped } from "../../core/test/fixture/tmpdir"
import { it } from "../../core/test/lib/effect"
import { startServer } from "./fixture/server"

const CHUNK = 8 * 1024 * 1024

const setup = Effect.gen(function* () {
  const tmp = yield* tmpdirScoped()
  const project = path.join(tmp.path, "project")
  yield* Effect.promise(() => fs.mkdir(project, { recursive: true }))
  const server = yield* startServer(path.join(tmp.path, "config"))
  const call = (method: string, route: string, init?: { query?: Record<string, string>; body?: BodyInit; json?: unknown }) =>
    Effect.promise(async () => {
      const url = new URL(`/api/experimental/fs/${route}`, server.base)
      url.searchParams.set("location[directory]", project)
      Object.entries(init?.query ?? {}).forEach(([key, value]) => url.searchParams.set(key, value))
      return fetch(url, {
        method,
        headers: { ...server.headers, ...(init?.json !== undefined ? { "content-type": "application/json" } : init?.body ? { "content-type": "application/octet-stream" } : {}) },
        body: init?.json === undefined ? init?.body : JSON.stringify(init.json),
      })
    })
  const start = (name: string, size: number, onConflict?: string) =>
    call("POST", "upload", { json: { path: name, size, onConflict } }).pipe(
      Effect.flatMap((response) => Effect.promise(async () => ({ status: response.status, body: await response.json() }))),
    )
  const chunk = (id: string, index: number, bytes: Uint8Array) =>
    call("PUT", `upload/${id}/chunk`, { query: { index: String(index) }, body: bytes as BodyInit })
  return { project, call, start, chunk }
})

const bytes = (length: number, seed: number) => Uint8Array.from({ length }, (_, at) => (at + seed) % 251)

it.live("uploads out of order, resumes from what the server holds and publishes the file only on completion", () =>
  Effect.gen(function* () {
    const { project, call, start, chunk } = yield* setup
    const data = bytes(CHUNK * 2 + 1000, 7)
    const created = yield* start("big/file.bin", data.length)
    expect(created.status).toBe(200)
    const id = created.body.data.uploadID
    expect(created.body.data.chunkSize).toBe(CHUNK)

    // The last chunk first, as a retry or a parallel sender might.
    expect((yield* chunk(id, 2, data.subarray(CHUNK * 2))).status).toBe(204)
    expect((yield* chunk(id, 0, data.subarray(0, CHUNK))).status).toBe(204)
    const state = yield* call("GET", `upload/${id}`).pipe(Effect.flatMap((r) => Effect.promise(() => r.json())))
    expect(state.data.received).toEqual([0, 2])
    expect(yield* Effect.promise(() => Bun.file(path.join(project, "big/file.bin")).exists())).toBe(false)

    const early = yield* call("POST", `upload/${id}/complete`)
    expect(early.status).toBe(400)

    // Sending a chunk again is harmless.
    expect((yield* chunk(id, 0, data.subarray(0, CHUNK))).status).toBe(204)
    expect((yield* chunk(id, 1, data.subarray(CHUNK, CHUNK * 2))).status).toBe(204)
    const done = yield* call("POST", `upload/${id}/complete`)
    expect(done.status).toBe(200)
    const written = new Uint8Array(yield* Effect.promise(() => fs.readFile(path.join(project, "big/file.bin"))))
    expect(written.byteLength).toBe(data.byteLength)
    expect(Buffer.compare(written, data)).toBe(0)
    // Nothing is left behind, and the upload is gone.
    expect(yield* Effect.promise(() => fs.readdir(path.join(project, ".opencode/upload")))).toEqual([])
    expect((yield* call("GET", `upload/${id}`)).status).toBe(404)
  }),
)

it.live("rejects chunks of the wrong size or past the end, and unknown uploads", () =>
  Effect.gen(function* () {
    const { start, chunk } = yield* setup
    const created = yield* start("a.bin", CHUNK + 10)
    const id = created.body.data.uploadID
    expect((yield* chunk(id, 0, new Uint8Array(5))).status).toBe(400)
    expect((yield* chunk(id, 1, new Uint8Array(11))).status).toBe(400)
    expect((yield* chunk(id, 2, new Uint8Array(10))).status).toBe(400)
    expect((yield* chunk("../../etc", 0, new Uint8Array(1))).status).toBe(404)
    expect((yield* chunk("00000000-0000-4000-8000-000000000000", 0, new Uint8Array(1))).status).toBe(404)
  }),
)

it.live("decides what happens to an existing file when the upload starts and again when it finishes", () =>
  Effect.gen(function* () {
    const { project, call, start, chunk } = yield* setup
    yield* Effect.promise(() => fs.writeFile(path.join(project, "report.txt"), "old"))
    const finish = (id: string, content: string) =>
      chunk(id, 0, new TextEncoder().encode(content)).pipe(Effect.flatMap(() => call("POST", `upload/${id}/complete`)))

    expect((yield* start("report.txt", 3)).status).toBe(409)

    const replace = yield* start("report.txt", 3, "replace")
    expect((yield* finish(replace.body.data.uploadID, "new")).status).toBe(200)
    expect(yield* Effect.promise(() => fs.readFile(path.join(project, "report.txt"), "utf8"))).toBe("new")

    const keep = yield* start("report.txt", 4, "rename")
    expect((yield* finish(keep.body.data.uploadID, "both")).status).toBe(200)
    expect(yield* Effect.promise(() => fs.readFile(path.join(project, "report (1).txt"), "utf8"))).toBe("both")
    expect(yield* Effect.promise(() => fs.readFile(path.join(project, "report.txt"), "utf8"))).toBe("new")

    // A file that appears while the upload runs is not overwritten unless the upload said so.
    const racing = yield* start("race.txt", 1)
    yield* Effect.promise(() => fs.writeFile(path.join(project, "race.txt"), "x"))
    expect((yield* finish(racing.body.data.uploadID, "y")).status).toBe(409)
    expect(yield* Effect.promise(() => fs.readFile(path.join(project, "race.txt"), "utf8"))).toBe("x")
  }),
)

it.live("cancelling discards the parts, and a file over the limit is refused without leaving anything", () =>
  Effect.gen(function* () {
    const { project, call, start, chunk } = yield* setup
    const created = yield* start("gone.bin", 10)
    const id = created.body.data.uploadID
    yield* chunk(id, 0, new Uint8Array(10))
    expect((yield* call("DELETE", `upload/${id}`)).status).toBe(204)
    expect(yield* Effect.promise(() => fs.readdir(path.join(project, ".opencode/upload")))).toEqual([])
    expect((yield* call("GET", `upload/${id}`)).status).toBe(404)

    const huge = yield* start("huge.bin", 1024 ** 5)
    expect(huge.status).toBe(400)
    expect(yield* Effect.promise(() => fs.readdir(path.join(project, ".opencode/upload")))).toEqual([])
  }),
)

it.live("holds a zero byte file and picks bigger chunks for very large ones", () =>
  Effect.gen(function* () {
    const { project, call, start } = yield* setup
    const empty = yield* start("empty.bin", 0)
    expect((yield* call("POST", `upload/${empty.body.data.uploadID}/complete`)).status).toBe(200)
    expect((yield* Effect.promise(() => fs.stat(path.join(project, "empty.bin")))).size).toBe(0)

    const big = yield* start("sparse.bin", 40 * 1024 ** 3)
    expect(big.status).toBe(200)
    expect(big.body.data.chunkSize).toBe(32 * 1024 * 1024)
    yield* call("DELETE", `upload/${big.body.data.uploadID}`)
  }),
)
