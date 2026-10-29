import { expect } from "bun:test"
import { Effect } from "effect"
import { Gateway } from "@opencode/protocol/gateway"
import { it } from "../../core/test/lib/effect"

process.env.OPENCODE_ADMIN_EMPLOYEE_ID = "8000"
process.env.OPENCODE_ADMIN_PASSWORD = "password-1"

const { ServerFetch } = await import("../src/fetch")

const options = {
  app: { version: "test-version" },
  database: { path: ":memory:" },
  config: { project: false },
  models: { fetch: false },
  fs: { filewatcher: false },
  password: "server-secret",
  gatewaySecret: "gateway-secret",
} as const

it.live("requests carrying an actor signed by the gateway are authenticated as that actor", () =>
  Effect.gen(function* () {
    const handler = yield* ServerFetch.make(options)
    const actor: Gateway.Actor = {
      userID: "usr_gateway",
      employeeID: "8000",
      admin: true,
      organizationID: undefined,
      organizationAdmin: true,
      settingsPages: [],
      organizations: [],
    }
    const call = (header?: string) =>
      Effect.promise(async () =>
        (
          await handler(
            new Request("http://opencode.local/api/project", {
              headers: header ? { [Gateway.ACTOR_HEADER]: header } : {},
            }),
          )
        ).status,
      )

    expect(yield* call()).toBe(401)
    expect(yield* call(Gateway.sign("gateway-secret", actor))).toBe(200)
    expect(yield* call(Gateway.sign("other-secret", actor))).toBe(401)
    expect(yield* call(Gateway.sign("gateway-secret", actor, Date.now() - 2 * Gateway.ACTOR_TTL_SECONDS * 1000))).toBe(401)
  }),
)
