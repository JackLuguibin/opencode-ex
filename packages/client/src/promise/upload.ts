/**
 * Sends one file to the server in small chunks so it can be any size, survives a dropped connection and can be
 * resumed. The engine knows nothing about HTTP: a transport does the requests, so tests can stand in for the server.
 */

export interface UploadState {
  readonly uploadID: string
  readonly chunkSize: number
  /** Chunk numbers the server already holds. */
  readonly received: ReadonlyArray<number>
}

export interface UploadTransport {
  readonly create: (
    input: { readonly path: string; readonly size: number; readonly onConflict?: "fail" | "replace" | "rename" },
    signal: AbortSignal,
  ) => Promise<UploadState>
  readonly state: (uploadID: string, signal: AbortSignal) => Promise<UploadState>
  /** `report` is called with the bytes of this chunk sent so far. */
  readonly chunk: (
    uploadID: string,
    index: number,
    body: Blob,
    report: (loaded: number) => void,
    signal: AbortSignal,
  ) => Promise<void>
  readonly complete: (uploadID: string, signal: AbortSignal) => Promise<{ readonly path: string; readonly size: number }>
  readonly cancel: (uploadID: string) => Promise<void>
}

/** A failed request. Statuses in the 4xx range other than 408 and 429 will not succeed when sent again. */
export class UploadHttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
    this.name = "UploadHttpError"
  }
}

export interface UploadProgress {
  readonly loaded: number
  readonly total: number
}

export interface UploadOptions {
  readonly transport: UploadTransport
  readonly file: Blob
  readonly path: string
  readonly onConflict?: "fail" | "replace" | "rename"
  /** Continue an upload the server already knows instead of starting one; a gone upload starts over. */
  readonly resume?: string
  readonly signal?: AbortSignal
  /** Chunks sent at the same time. */
  readonly concurrency?: number
  /** Times one chunk is sent again after a failure before the upload fails. */
  readonly retries?: number
  /** Called as soon as the server has an upload, so a caller can resume or cancel it later. */
  readonly onStart?: (uploadID: string) => void
  readonly onProgress?: (progress: UploadProgress) => void
  /** How long to wait before retry `attempt` (from 1), in milliseconds. */
  readonly backoff?: (attempt: number) => number
}

export async function upload(options: UploadOptions) {
  const signal = options.signal ?? new AbortController().signal
  const total = options.file.size
  const started = await begin(options, signal)
  options.onStart?.(started.uploadID)

  const count = Math.ceil(total / started.chunkSize)
  const done = new Set(started.received)
  // Totals are kept as running sums: progress fires many times a second and a 10 GiB file has thousands of chunks.
  const sizes = { done: [...done].reduce((sum, index) => sum + length(index, count, total, started.chunkSize), 0), inflight: 0 }
  const sent = new Map<number, number>()
  const report = () => options.onProgress?.({ loaded: sizes.done + sizes.inflight, total })
  report()

  const pending = Array.from({ length: count }, (_, index) => index).filter((index) => !done.has(index))
  const worker = async () => {
    for (let index = pending.shift(); index !== undefined; index = pending.shift()) {
      const body = options.file.slice(index * started.chunkSize, index * started.chunkSize + length(index, count, total, started.chunkSize))
      await retrying(options, signal, () =>
        options.transport.chunk(started.uploadID, index, body, (loaded) => {
          sizes.inflight += loaded - (sent.get(index) ?? 0)
          sent.set(index, loaded)
          report()
        }, signal),
      ).finally(() => {
        sizes.inflight -= sent.get(index) ?? 0
        sent.delete(index)
      })
      done.add(index)
      sizes.done += body.size
      report()
    }
  }
  // One failed worker stops the others from picking up more chunks.
  await Promise.all(Array.from({ length: Math.min(options.concurrency ?? 3, count) }, worker)).catch((error) => {
    pending.length = 0
    throw error
  })
  return retrying(options, signal, () => options.transport.complete(started.uploadID, signal))
}

async function begin(options: UploadOptions, signal: AbortSignal) {
  if (options.resume) {
    const existing = await options.transport.state(options.resume, signal).catch((error) => {
      if (error instanceof UploadHttpError && error.status === 404) return undefined
      throw error
    })
    if (existing) return existing
  }
  return options.transport.create(
    { path: options.path, size: options.file.size, onConflict: options.onConflict },
    signal,
  )
}

function length(index: number, count: number, total: number, chunkSize: number) {
  return index === count - 1 ? total - index * chunkSize : chunkSize
}

async function retrying<A>(options: UploadOptions, signal: AbortSignal, run: () => Promise<A>) {
  const retries = options.retries ?? 3
  for (let attempt = 1; ; attempt++) {
    try {
      return await run()
    } catch (error) {
      if (signal.aborted || attempt > retries || !retryable(error)) throw error
      await sleep((options.backoff ?? ((n) => 500 * 2 ** (n - 1)))(attempt), signal)
    }
  }
}

function retryable(error: unknown) {
  if (!(error instanceof UploadHttpError)) return true
  return error.status >= 500 || error.status === 408 || error.status === 429
}

function sleep(ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", stop)
      resolve()
    }, ms)
    const stop = () => {
      clearTimeout(timer)
      reject(new DOMException("Upload aborted", "AbortError"))
    }
    signal.addEventListener("abort", stop, { once: true })
  })
}
