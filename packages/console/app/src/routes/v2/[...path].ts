import type { APIEvent } from "@solidjs/start/server"
import { config } from "~/config"
import { proxyDocs } from "~/lib/docs-proxy"

function handler(event: APIEvent) {
  return proxyDocs(event.request, new URL(event.request.url).pathname, config.v2DocsUrl)
}

export const GET = handler
export const HEAD = handler
