import { expect, test } from "bun:test"
import { ReplayGuard } from "../src/replay-guard"

test("an id is accepted once and refused until it expires", () => {
  const guard = ReplayGuard.make()
  const now = 1_000_000
  expect(guard.seen("a", now / 1000 + 60, now)).toBe(false)
  expect(guard.seen("a", now / 1000 + 60, now + 1_000)).toBe(true)
  expect(guard.seen("b", now / 1000 + 60, now + 1_000)).toBe(false)
  // Once the header itself has expired nothing can replay it, so the entry is forgotten.
  expect(guard.seen("a", now / 1000 + 120, now + 61_000)).toBe(false)
})

test("the oldest ids are dropped first when the table is full", () => {
  const guard = ReplayGuard.make(2)
  const now = 1_000_000
  for (const id of ["a", "b", "c"]) guard.seen(id, now / 1000 + 60, now)
  expect(guard.seen("c", now / 1000 + 60, now)).toBe(true)
  expect(guard.seen("a", now / 1000 + 60, now)).toBe(false)
})
