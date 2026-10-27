import { expect, test } from "bun:test"
import { localDevPassword, serverPassword } from "../src/server-password"

const random = "random-password"

test("loopback serve uses the shared dev password unless one is configured", () => {
  expect(serverPassword({ mode: "default", hostname: "127.0.0.1", random })).toBe(localDevPassword)
  expect(serverPassword({ mode: "default", hostname: "localhost", random })).toBe(localDevPassword)
  expect(
    serverPassword({ mode: "default", hostname: "127.0.0.1", configured: "from-env", random }),
  ).toBe("from-env")
})

test("a public serve address keeps a random password until one is configured", () => {
  expect(serverPassword({ mode: "default", hostname: "0.0.0.0", random })).toBe(random)
  expect(serverPassword({ mode: "default", hostname: "0.0.0.0", configured: "from-env", random })).toBe("from-env")
})

test("service and stdio modes do not use the web dev password", () => {
  expect(serverPassword({ mode: "service", hostname: "127.0.0.1", servicePassword: "saved", random })).toBe("saved")
  expect(serverPassword({ mode: "service", hostname: "127.0.0.1", random })).toBe(random)
  expect(serverPassword({ mode: "stdio", hostname: "127.0.0.1", random })).toBe(random)
})
