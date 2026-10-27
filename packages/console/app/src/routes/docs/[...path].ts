import type { APIEvent } from "@solidjs/start/server"
import { config } from "~/config"
import { docs, pageLocale } from "~/lib/language"
import { proxyDocs } from "~/lib/docs-proxy"

function handler(event: APIEvent) {
  const url = new URL(event.request.url)
  return proxyDocs(event.request, docs(pageLocale(event.request), url.pathname), config.v1DocsUrl)
}

export const GET = handler
export const HEAD = handler
