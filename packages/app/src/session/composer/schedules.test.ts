import { describe, expect, test } from "bun:test"
import type { ScheduleInfo } from "@opencode/client/promise"
import { nextRun, sortSchedules } from "./schedules"

const item = (overrides: Partial<ScheduleInfo>) =>
  ({
    id: "sch_1",
    when: { type: "every", every: "5 minutes" },
    tz: "UTC",
    action: { type: "prompt", prompt: "check the build" },
    status: "active",
    runCount: 0,
    time: { created: 0, updated: 0 },
    ...overrides,
  }) as ScheduleInfo

describe("session schedules", () => {
  test("lists finished schedules after live ones", () => {
    const done = item({ id: "sch_done", status: "done" })
    const paused = item({ id: "sch_paused", status: "paused" })
    expect(sortSchedules([done, paused]).map((entry) => entry.id)).toEqual(["sch_paused", "sch_done"])
  })

  test("next run ignores paused and finished schedules", () => {
    expect(
      nextRun([
        item({ nextDueAt: 300 }),
        item({ nextDueAt: 100, status: "paused" }),
        item({ nextDueAt: 200 }),
        item({ nextDueAt: 50, status: "done" }),
      ]),
    ).toBe(200)
    expect(nextRun([item({ status: "paused", nextDueAt: 1 })])).toBeUndefined()
  })
})
