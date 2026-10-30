import { FSUtil } from "@opencode/util/fs-util"
import { Effect, FileSystem } from "effect"
import { HttpServerError, HttpServerRequest, HttpServerResponse } from "effect/http"
import { createHash } from "node:crypto"
import { load, type AssetMap, type BrotliMap } from "../app-assets"

export const handler = Effect.fn("cli.web-ui.handler")(function* (options?: {
  readonly assets?: AssetMap
  readonly brotli?: BrotliMap
}) {
  const fileSystem = yield* FileSystem.FileSystem
  const assets = options?.assets
    ? Effect.succeed({ files: options.assets, brotli: options.brotli })
    : yield* Effect.cached(load().pipe(Effect.provideService(FileSystem.FileSystem, fileSystem)))
  return <E, R>(api: Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>) =>
    Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest
      const url = new URL(request.url, "http://localhost")
      // Serve the web shell before API authentication so a signed-out browser gets the app's sign-in screen.
      if (
        url.pathname === "/api" ||
        url.pathname.startsWith("/api/") ||
        url.pathname.startsWith("/auth/") ||
        url.pathname === "/openapi.json"
      )
        return yield* api.pipe(
          Effect.catchIf(isRouteNotFound, () => Effect.succeed(HttpServerResponse.empty({ status: 404 }))),
        )
      return yield* assets.pipe(Effect.flatMap((loaded) => serveUI(request, url, loaded.files, loaded.brotli)))
    })
})

function serveUI(
  request: HttpServerRequest.HttpServerRequest,
  url: URL,
  assets: AssetMap,
  brotli: BrotliMap | undefined,
) {
  const found = asset({ method: request.method, acceptEncoding: request.headers["accept-encoding"], pathname: url.pathname }, assets, brotli)
  if (!found.body)
    return Effect.succeed(HttpServerResponse.empty({ status: found.status, headers: found.headers }))
  return Effect.succeed(
    found.method === "HEAD"
      ? HttpServerResponse.empty({ status: 200, headers: found.headers })
      : HttpServerResponse.raw(found.body, { headers: found.headers, contentType: found.headers["content-type"] }),
  )
}

/** The embedded web app as a plain `Response`, for servers that are not the execution layer (the gateway). */
export function response(request: Request, assets: AssetMap, brotli: BrotliMap | undefined) {
  const found = asset(
    { method: request.method, acceptEncoding: request.headers.get("accept-encoding") ?? undefined, pathname: new URL(request.url).pathname },
    assets,
    brotli,
  )
  if (!found.body || found.method === "HEAD") return new Response(null, { status: found.status, headers: found.headers })
  return new Response(typeof found.body === "string" ? found.body : Buffer.from(found.body), { headers: found.headers })
}

function asset(
  request: { method: string; acceptEncoding: string | undefined; pathname: string },
  assets: AssetMap,
  brotli: BrotliMap | undefined,
) {
  const key = request.pathname.replace(/^\//, "")
  // A browser that takes brotli gets the embedded bytes as they are, so the server decompresses nothing. The HTML stays
  // decoded, because its CSP hashes the inline theme script.
  const encoded = !renamed(key) && acceptsBrotli(request.acceptEncoding) ? brotli?.[key] : undefined
  const requested = encoded ?? assets[key]
  const missing = (status: number, headers: Record<string, string> = {}) => ({
    status,
    headers,
    method: request.method,
    body: undefined,
  })
  if ((key.startsWith("_assets/") || key.startsWith("icons/")) && requested === undefined)
    return missing(404, { "cache-control": "no-store" })
  const name = requested !== undefined ? key : "index.html"
  const file = requested ?? assets["index.html"]
  if (file === undefined) return missing(404)
  if (request.method !== "GET" && request.method !== "HEAD") return missing(405)
  const html = name === "index.html"
  const body = renamed(name) ? withTitle(name, file) : file
  const revalidate = html || name === "sw.js" || name === "registerSW.js"
  const headers: Record<string, string> = {
    "content-type": FSUtil.mimeType(name),
    "cache-control": revalidate ? "no-cache" : "public, max-age=31536000, immutable",
    "content-security-policy": html ? cspForHtml(typeof body === "string" ? body : Buffer.from(body).toString()) : csp(),
    "x-content-type-options": "nosniff",
    ...(!html && brotli?.[name] !== undefined ? { vary: "accept-encoding" } : {}),
    ...(encoded ? { "content-encoding": "br" } : {}),
  }
  return { status: 200, headers, method: request.method, body }
}

// OPENCODE_WEB_TITLE renames the product for a deployment: the tab title (the app reads it back as its product name)
// and the installed app's name. Those two files are served decoded, never from the brotli copy.
function renamed(name: string) {
  return (name === "index.html" || name === "site.webmanifest") && Boolean(process.env.OPENCODE_WEB_TITLE?.trim())
}

function withTitle(name: string, file: string | Uint8Array) {
  const title = process.env.OPENCODE_WEB_TITLE!.trim()
  const text = typeof file === "string" ? file : Buffer.from(file).toString()
  if (name === "site.webmanifest")
    return JSON.stringify({ ...JSON.parse(text), name: title, short_name: title })
  const escaped = title.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
  return text.replace(/(<title\b[^>]*>)[^<]*(<\/title>)/i, (_, open: string, close: string) => `${open}${escaped}${close}`)
}

function acceptsBrotli(header: string | undefined) {
  return (header ?? "").split(",").some((entry) => {
    const parts = entry.split(";").map((part) => part.trim().toLowerCase())
    return parts[0] === "br" && !parts.slice(1).some((part) => /^q=0(?:\.0*)?$/.test(part))
  })
}

function isRouteNotFound(error: unknown) {
  return error instanceof HttpServerError.HttpServerError && error.reason._tag === "RouteNotFound"
}

// qr-scanner decodes in a worker it creates from a blob: URL whenever the browser has no BarcodeDetector (Safari, desktop
// Chrome on Windows and Linux). Without worker-src that worker falls under script-src 'self' and never starts.
function csp(hash = "") {
  return `default-src 'self'; script-src 'self' 'wasm-unsafe-eval'${hash ? ` 'sha256-${hash}'` : ""}; style-src 'self' 'unsafe-inline'; img-src 'self' data: https: blob:; font-src 'self' data:; media-src 'self' data:; connect-src * data: blob:; worker-src 'self' blob:`
}

function cspForHtml(body: string) {
  const match = body.match(
    /<script\b(?![^>]*\bsrc\s*=)[^>]*\bid=(["'])oc-theme-preload-script\1[^>]*>([\s\S]*?)<\/script>/i,
  )
  return csp(match ? createHash("sha256").update(match[2]).digest("base64") : "")
}

export * as WebUi from "./web-ui"
