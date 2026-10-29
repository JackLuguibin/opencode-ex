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
