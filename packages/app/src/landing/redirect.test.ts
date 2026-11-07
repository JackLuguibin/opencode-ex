import { expect, test } from "bun:test"
import { shouldShowLanding } from "./redirect"

test("only an unseen start page opened on the root redirects", () => {
  expect(shouldShowLanding({ seen: false, pathname: "/" })).toBe(true)
  expect(shouldShowLanding({ seen: true, pathname: "/" })).toBe(false)
  expect(shouldShowLanding({ seen: false, pathname: "/queue" })).toBe(false)
})
