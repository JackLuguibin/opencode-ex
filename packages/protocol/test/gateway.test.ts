import { createHmac } from "node:crypto"
import { expect, test } from "bun:test"
import { Gateway } from "../src/gateway.js"
import { AuthGroup } from "../src/groups/auth.js"

test("every route of the identity group is recognised as identity-owned", () => {
  const paths = Object.values(AuthGroup.endpoints).map((endpoint) => endpoint.path.replace(/:[A-Za-z]+/g, "x"))
  expect(paths.length).toBeGreaterThan(30)
  expect(paths.filter((path) => !Gateway.isIdentityPath(path))).toEqual([])
})

test("routes outside the identity group are not", () => {
  for (const path of ["/api/project", "/api/session/ses_1/message", "/api/session/ses_1", "/api/event"])
    expect(Gateway.isIdentityPath(path)).toBe(false)
})

const actor: Gateway.Actor = {
  userID: "usr_1",
  employeeID: "1001",
  admin: false,
  organizationID: "org_1",
  organizationAdmin: false,
  settingsPages: [],
  organizations: [],
}

test("a signed header verifies only with its key, and carries a fresh id each time", () => {
  const header = Gateway.sign("old", actor)
  expect(Gateway.verify("old", header)).toEqual(actor)
  expect(Gateway.verify("new", header)).toBeUndefined()
  expect(Gateway.claim("old", header)?.jti).toBeTruthy()
  expect(Gateway.claim("old", header)?.jti).toBe(Gateway.claim("old", header)?.jti)
  expect(Gateway.claim("old", Gateway.sign("old", actor))?.jti).not.toBe(Gateway.claim("old", header)?.jti)
})

test("any listed key verifies, which lets a key be rotated without a gap", () => {
  const next = Gateway.sign("new", actor)
  const previous = Gateway.sign("old", actor)
  for (const header of [next, previous]) expect(Gateway.verify(["old", "new"], header)).toEqual(actor)
  expect(Gateway.verify(["old"], next)).toBeUndefined()
  expect(Gateway.verify(["other", "unrelated"], previous)).toBeUndefined()
})

test("a header that is expired or tampered with is refused whatever keys are listed", () => {
  const now = Date.now()
  expect(Gateway.verify(["old", "new"], Gateway.sign("old", actor, now - 2 * Gateway.ACTOR_TTL_SECONDS * 1000))).toBeUndefined()
  const [payload, mac] = Gateway.sign("old", actor).split(".")
  const forged = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(payload, "base64url").toString()), admin: true })).toString("base64url")
  expect(Gateway.verify(["old", "new"], `${forged}.${mac}`)).toBeUndefined()
})

test("a header from before ids existed still verifies, with nothing to check for replay", () => {
  const exp = Math.floor(Date.now() / 1000) + Gateway.ACTOR_TTL_SECONDS
  const payload = Buffer.from(JSON.stringify({ ...actor, exp })).toString("base64url")
  // Signed the way the previous version did, by borrowing the current signature of the same payload.
  const mac = createHmac("sha256", createHmac("sha256", "old").update("opencode-gateway-v1").digest()).update(payload).digest("base64url")
  const legacy = `${payload}.${mac}`
  expect(Gateway.verify("old", legacy)).toEqual(actor)
  expect(Gateway.claim("old", legacy)?.jti).toBeUndefined()
})
