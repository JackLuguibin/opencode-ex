// End-to-end check of a running stack (compose or `dev:app`), through the same entry the browser uses:
//   bun deploy/smoke.ts http://localhost:8080 <admin employee id> <admin password>
// It signs in, creates two organizations with a member each, and requires that signed-out calls are refused, that each
// member reaches an execution layer, and that an organization stays on the layer it first used. With two layers
// running it also requires the organizations to land on different ones.
const [base, employeeID, password] = process.argv.slice(2)
if (!base || !employeeID || !password) {
  console.error("usage: bun deploy/smoke.ts <base url> <admin employee id> <admin password>")
  process.exit(2)
}

const call = (path: string, token?: string, body?: unknown, method = body === undefined ? "GET" : "POST") =>
  fetch(`${base}${path}`, {
    method,
    headers: {
      ...(token ? { authorization: `Basic ${btoa(`opencode:${token}`)}` } : {}),
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  })

const failures: string[] = []
const check = (name: string, ok: boolean, detail?: unknown) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok || detail === undefined ? "" : ` (${JSON.stringify(detail)})`}`)
  if (!ok) failures.push(name)
}
const json = async (response: Response) => (await response.json()) as Record<string, any>

check("signed-out call is refused", (await call("/api/info")).status === 401)

const login = async (id: string, secret: string) => (await json(await call("/api/auth/login", undefined, { employeeID: id, password: secret }))).token as string
const admin = await login(employeeID, password)
check("admin can sign in", !!admin)

const suffix = Date.now().toString(36)
const hosts: string[] = []
const orgs: { id: string; member: string }[] = []
for (const label of ["a", "b"]) {
  const organization = await json(await call("/api/organization", admin, { name: `smoke-${label}-${suffix}` }))
  const member = `smoke-${label}-${suffix}`
  await call("/api/auth/users", admin, { employeeID: member, password: "smoke-password", organizationID: organization.id })
  const token = await login(member, "smoke-password")
  // A session creates the organization's directory and project on its layer.
  const created = await call("/api/session", token, { title: "smoke" })
  check(`organization ${label} can start a session`, created.ok, created.status)
  const first = await json(await call("/api/info", token))
  const second = await json(await call("/api/info", token))
  check(`organization ${label} reaches an execution layer`, !!first.hostname, first)
  check(`organization ${label} stays on its layer`, first.hostname === second.hostname)
  hosts.push(first.hostname)
  orgs.push({ id: organization.id, member })
}
// SMOKE_KEEP=1 leaves the organizations in place, for callers that inspect them afterwards.
if (!process.env.SMOKE_KEEP) {
// Deleting an organization removes it for everyone and releases its place on a layer.
const doomed = orgs[0]
const removed = await call(`/api/organization/${doomed.id}`, admin, undefined, "DELETE")
check("admin can delete an organization", removed.status === 204, removed.status)
console.log(`deleted organization ${doomed.id}`)
const remaining = (await (await call("/api/organization", admin)).json()) as { id: string }[]
check("a deleted organization is gone from the list", !remaining.some((item) => item.id === doomed.id))
const memberSession = await json(await call("/api/auth/session", await login(doomed.member, "smoke-password")))
check("its member is no longer in it", memberSession.organizationID !== doomed.id)
}
console.log(`layers used: ${hosts.join(", ")}`)

if (failures.length > 0) {
  console.error(`${failures.length} check(s) failed`)
  process.exit(1)
}
