import type { APIEvent } from "@solidjs/start/server"

export function GET(event: APIEvent) {
  const origin = new URL(event.request.url).origin
  return new Response(`User-agent: *\nAllow: /\nSitemap: ${origin}/sitemap.xml\nSitemap: ${origin}/v2/sitemap.xml\n`, {
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  })
}
