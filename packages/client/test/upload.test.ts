import { expect, test } from "bun:test"
import { upload, UploadHttpError, type UploadTransport } from "../src/promise/upload"

const CHUNK = 4

/** A server in memory: chunks by index, with hooks to break requests. */
function fake(options?: { chunkSize?: number; fail?: (index: number, attempt: number) => Error | undefined }) {
  const chunkSize = options?.chunkSize ?? CHUNK
  const held = new Map<number, Uint8Array>()
  const attempts = new Map<number, number>()
  const inflight = { now: 0, peak: 0 }
  const calls = { create: 0, state: 0, complete: 0, cancel: 0 }
  let size = 0
  const transport: UploadTransport = {
    create: async (input) => {
      calls.create++
      size = input.size
      return { uploadID: "u1", chunkSize, received: [...held.keys()] }
    },
    state: async (id) => {
      calls.state++
      if (id !== "u1") throw new UploadHttpError(404, "gone")
      return { uploadID: "u1", chunkSize, received: [...held.keys()] }
    },
    chunk: async (_id, index, body, report, signal) => {
      inflight.now++
      inflight.peak = Math.max(inflight.peak, inflight.now)
      const attempt = (attempts.get(index) ?? 0) + 1
      attempts.set(index, attempt)
      await new Promise((resolve) => setTimeout(resolve, 1))
      inflight.now--
      if (signal.aborted) throw new DOMException("aborted", "AbortError")
      const error = options?.fail?.(index, attempt)
      if (error) throw error
      report(body.size)
      held.set(index, new Uint8Array(await body.arrayBuffer()))
    },
    complete: async () => {
      calls.complete++
      return { path: "/x", size }
    },
    cancel: async () => {
      calls.cancel++
    },
  }
  const assemble = () => new Uint8Array([...[...held.entries()].sort((a, b) => a[0] - b[0]).flatMap(([, bytes]) => [...bytes])])
  return { transport, held, attempts, inflight, calls, assemble }
}

const data = Uint8Array.from({ length: 23 }, (_, at) => at + 1)
const quick = { backoff: () => 0 }

test("sends every chunk, reports progress up to the total and completes once", async () => {
  const server = fake()
  const seen: number[] = []
  const result = await upload({ transport: server.transport, file: new Blob([data]), path: "a.bin", onProgress: (p) => seen.push(p.loaded), ...quick })
  expect(result).toEqual({ path: "/x", size: 23 })
  expect(server.assemble()).toEqual(data)
  expect(seen.at(-1)).toBe(23)
  expect(seen).toEqual([...seen].sort((a, b) => a - b))
  expect(server.calls.complete).toBe(1)
})

test("never has more chunks in flight than the concurrency allows", async () => {
  const server = fake()
  await upload({ transport: server.transport, file: new Blob([data]), path: "a.bin", concurrency: 2, ...quick })
  expect(server.inflight.peak).toBe(2)
})

test("sends a failed chunk again, and gives up after the retries", async () => {
  const flaky = fake({ fail: (index, attempt) => (index === 1 && attempt < 3 ? new Error("reset") : undefined) })
  await upload({ transport: flaky.transport, file: new Blob([data]), path: "a.bin", ...quick })
  expect(flaky.attempts.get(1)).toBe(3)
  expect(flaky.assemble()).toEqual(data)

  const broken = fake({ fail: (index) => (index === 1 ? new Error("reset") : undefined) })
  await expect(upload({ transport: broken.transport, file: new Blob([data]), path: "a.bin", retries: 2, ...quick })).rejects.toThrow("reset")
  expect(broken.attempts.get(1)).toBe(3)
  expect(broken.calls.complete).toBe(0)
})

test("does not retry what the server refused", async () => {
  const refused = fake({ fail: (index) => (index === 0 ? new UploadHttpError(400, "wrong size") : undefined) })
  await expect(upload({ transport: refused.transport, file: new Blob([data]), path: "a.bin", ...quick })).rejects.toThrow("wrong size")
  expect(refused.attempts.get(0)).toBe(1)
})

test("resumes by sending only the chunks the server lacks", async () => {
  const server = fake()
  const first = new AbortController()
  await expect(
    upload({
      transport: server.transport,
      file: new Blob([data]),
      path: "a.bin",
      concurrency: 1,
      signal: first.signal,
      onProgress: (p) => p.loaded >= 8 && first.abort(),
      ...quick,
    }),
  ).rejects.toBeDefined()
  const before = server.held.size
  expect(before).toBeGreaterThan(0)
  expect(before).toBeLessThan(6)

  const sentAgain = new Set<number>()
  const original = server.transport.chunk
  server.transport.chunk = (id, index, body, report, signal) => (sentAgain.add(index), original(id, index, body, report, signal))
  await upload({ transport: server.transport, file: new Blob([data]), path: "a.bin", resume: "u1", ...quick })
  expect(sentAgain.size).toBe(6 - before)
  expect(server.assemble()).toEqual(data)
  expect(server.calls.create).toBe(1)
})

test("starts over when the upload it should resume is gone", async () => {
  const server = fake()
  await upload({ transport: server.transport, file: new Blob([data]), path: "a.bin", resume: "old", ...quick })
  expect(server.calls.create).toBe(1)
  expect(server.assemble()).toEqual(data)
})

test("uploads an empty file with no chunks", async () => {
  const server = fake()
  expect(await upload({ transport: server.transport, file: new Blob([]), path: "a.bin", ...quick })).toEqual({ path: "/x", size: 0 })
  expect(server.held.size).toBe(0)
})
