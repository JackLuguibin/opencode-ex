import { describe, expect, test } from "bun:test"
import { ModelResolver } from "../src/model-resolver"

describe("ModelResolver.expandHeaders", () => {
  test("fills the names it knows and empties the ones it does not", () => {
    expect(
      ModelResolver.expandHeaders(
        { "X-Employee": "{{employeeID}}", "X-Scope": "{{ organization }}/{{missing}}", "X-Plain": "fixed" },
        { employeeID: "10001", organization: "R&D" },
      ),
    ).toEqual({ "X-Employee": "10001", "X-Scope": "R&D/", "X-Plain": "fixed" })
  })
})
