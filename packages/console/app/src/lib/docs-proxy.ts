/** Forward a read-only documentation request to the explicitly configured ex service. */
export async function proxyDocs(request: Request, pathname: string, origin: string | undefined) {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return new Response("Method not allowed", { status: 405, headers: { Allow: "GET, HEAD" } })
  }
  if (!origin) return new Response("Documentation service is not configured", { status: 503 })

  const target = new URL(origin)
  target.pathname = pathname
  target.search = new URL(request.url).search
  const headers = new Headers()
  for (const name of ["accept", "accept-language"]) {
    const value = request.headers.get(name)
    if (value) headers.set(name, value)
  }
  const response = await fetch(target, { method: request.method, headers, redirect: "manual" }).catch(() => undefined)
  if (!response) return new Response("Documentation service is unavailable", { status: 502 })

  const output = new Headers(response.headers)
  const location = output.get("location")
  if (location) {
    const redirect = new URL(location, target)
    if (redirect.origin === target.origin)
      output.set("location", `${redirect.pathname}${redirect.search}${redirect.hash}`)
  }
  return new Response(request.method === "HEAD" ? null : response.body, { status: response.status, headers: output })
}
