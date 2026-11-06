import type { ScheduleInfo } from "@opencode/client/promise"

/** Schedules that can still fire, oldest first as the server returns them; finished ones stay listed after the rest. */
export const sortSchedules = (items: readonly ScheduleInfo[]) =>
  items.toSorted((a, b) => Number(a.status === "done") - Number(b.status === "done"))

/** The earliest upcoming run among active schedules. */
export const nextRun = (items: readonly ScheduleInfo[]) =>
  items.reduce<number | undefined>(
    (soonest, item) =>
      item.status === "active" && item.nextDueAt !== undefined && (soonest === undefined || item.nextDueAt < soonest)
        ? item.nextDueAt
        : soonest,
    undefined,
  )

/** The schedule's own words for when it fires, e.g. `{ type: "every", value: "5 minutes" }`. */
export function whenParts(when: ScheduleInfo["when"]) {
  if (when.type === "in") return { type: when.type, value: when.in }
  if (when.type === "at") return { type: when.type, value: when.at }
  if (when.type === "every") return { type: when.type, value: when.every }
  return { type: when.type, value: when.cron }
}

export const scheduleTitle = (item: ScheduleInfo) => item.name?.trim() || item.action.prompt

export const formatScheduleTime = (locale: string, value: number) =>
  new Intl.DateTimeFormat(locale, { dateStyle: "short", timeStyle: "short" }).format(value)
