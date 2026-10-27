import { createMiddleware } from "@solidjs/start/middleware"
import { appleAppSiteAssociation } from "~/lib/apple-app-site-association"
import { LOCALE_HEADER, cookie, fromPathname, strip } from "~/lib/language"
import { sanitizeServerActionRequest } from "~/lib/server-action"

export default createMiddleware({
  async onRequest(event) {
    const association = appleAppSiteAssociation(event.request)
    if (association) return association

    event.request = sanitizeServerActionRequest(event.request)

    const url = new URL(event.request.url)
    const locale = fromPathname(url.pathname)
    if (locale) {
      url.pathname = strip(url.pathname)
      // English pages live at unprefixed URLs, so /en/... would be a duplicate of every page.
      // Collapse leading slashes so /en//example.com can't become a protocol-relative redirect.
      if (locale === "en" && (event.request.method === "GET" || event.request.method === "HEAD"))
        return new Response(null, {
          status: 301,
          headers: { Location: `${url.pathname.replace(/^\/+/, "/")}${url.search}` },
        })
      const request = new Request(url, event.request)
      request.headers.set(LOCALE_HEADER, locale)
      event.request = request
      event.response.headers.append("set-cookie", cookie(locale))
    }
  },
})
