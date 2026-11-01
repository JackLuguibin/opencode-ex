import { UploadHttpError, type UploadState, type UploadTransport } from "@opencode/client/promise"
import { authTokenFromCredentials } from "@/runtime/server/api"

type Body = { data: { uploadID: string; chunkSize: number; received: number[]; path: string; size: number }; message?: string }

/** Talks to the server's resumable upload routes. Chunks go through XMLHttpRequest because fetch reports no upload progress. */
export function uploadTransport(server: { url: string; password?: string }, directory: string): UploadTransport {
  const endpoint = (route: string, query: Record<string, string> = {}) => {
    const url = new URL(`/api/experimental/fs/upload${route}`, server.url)
    url.searchParams.set("location[directory]", directory)
    Object.entries(query).forEach(([key, value]) => url.searchParams.set(key, value))
    return url
  }
  const authorization: Record<string, string> = server.password ? { authorization: `Basic ${authTokenFromCredentials({ password: server.password })}` } : {}

  const request = async (method: string, url: URL, signal?: AbortSignal, json?: unknown) => {
    const response = await fetch(url, {
      method,
      signal,
      headers: { ...authorization, ...(json === undefined ? {} : { "content-type": "application/json" }) },
      body: json === undefined ? undefined : JSON.stringify(json),
    })
    if (response.ok) return response.status === 204 ? undefined : ((await response.json()) as Body)
    const detail = (await response.json().catch(() => undefined)) as Body | undefined
    throw new UploadHttpError(response.status, detail?.message ?? `Upload failed with status ${response.status}`)
  }

  const state = (body: Body | undefined): UploadState => ({
    uploadID: body!.data.uploadID,
    chunkSize: body!.data.chunkSize,
    received: body!.data.received,
  })

  return {
    create: async (input, signal) => state(await request("POST", endpoint(""), signal, input)),
    state: async (uploadID, signal) => state(await request("GET", endpoint(`/${uploadID}`), signal)),
    chunk: (uploadID, index, body, report, signal) =>
      new Promise<void>((resolve, reject) => {
        if (signal.aborted) return reject(new DOMException("Upload aborted", "AbortError"))
        const xhr = new XMLHttpRequest()
        xhr.open("PUT", endpoint(`/${uploadID}/chunk`, { index: String(index) }))
        xhr.setRequestHeader("content-type", "application/octet-stream")
        Object.entries(authorization).forEach(([name, value]) => xhr.setRequestHeader(name, value))
        xhr.upload.addEventListener("progress", (event) => report(event.loaded))
        xhr.addEventListener("load", () =>
          xhr.status >= 200 && xhr.status < 300
            ? resolve()
            : reject(new UploadHttpError(xhr.status, `Upload failed with status ${xhr.status}`)),
        )
        // No status means the connection broke, which is worth sending the chunk again for.
        xhr.addEventListener("error", () => reject(new Error("Upload failed")))
        xhr.addEventListener("abort", () => reject(new DOMException("Upload aborted", "AbortError")))
        signal.addEventListener("abort", () => xhr.abort(), { once: true })
        xhr.send(body)
      }),
    complete: async (uploadID, signal) => {
      const body = await request("POST", endpoint(`/${uploadID}/complete`), signal)
      return { path: body!.data.path, size: body!.data.size }
    },
    cancel: async (uploadID) => {
      await request("DELETE", endpoint(`/${uploadID}`)).catch(() => undefined)
    },
  }
}
