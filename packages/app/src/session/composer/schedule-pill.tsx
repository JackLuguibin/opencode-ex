import { Popover } from "@kobalte/core/popover"
import type { ScheduleInfo } from "@opencode/client/promise"
import { createEffect, createMemo, createResource, Index, on, onCleanup, Show } from "solid-js"
import { useLanguage } from "@/runtime/i18n/language"
import { useServerSDK } from "@/runtime/server/client"
import { useData } from "@/runtime/server/current"
import { errorMessage } from "@/shell/layout/helpers"
import { showToast } from "@/shell/notifications/toast"
import { useComposerLaneAlignment } from "./composer-lane"
import { ClockGlyph, ScheduleRow } from "./schedule-row"
import { formatScheduleTime, nextRun, sortSchedules } from "./schedules"
import "./schedule-pill.css"


// The session's scheduled prompts as one capsule in the composer lane: how many are live and when the next one fires,
// opening a popover that lists each with pause, resume and delete. The list is read from the server (it is not in the
// session's event stream), so it refreshes on a timer, when the session finishes a turn, and after each action.
export function SessionSchedulePill(props: { sessionID: NonNullable<ScheduleInfo["sessionID"]>; working: boolean }) {
  const language = useLanguage()
  const alignment = useComposerLaneAlignment()
  const server = useServerSDK()
  const data = useData()

  // A session whose location has `experimental.schedules` off answers 403: the capsule then stays away. The result
  // carries its session so a previous session's list is never shown while the next one loads.
  const [items, { refetch }] = createResource(
    () => props.sessionID,
    (sessionID) =>
      server.api.experimental.schedule
        .list({ sessionID })
        .catch(() => [])
        .then((schedules) => ({ sessionID, schedules })),
  )
  // The server announces each schedule change; events missed while the stream was down are caught on reconnect.
  onCleanup(data.on("schedule.changed", () => void refetch()))
  createEffect(
    on(
      () => server.connection.status(),
      (status, was) => {
        if (was !== undefined && status === "connected") void refetch()
      },
    ),
  )

  // The agent creates schedules through a tool call, so a turn ending is the moment a new one may exist.
  createEffect(
    on(
      () => props.working,
      (working, was) => {
        if (was && !working) void refetch()
      },
    ),
  )

  const loaded = () => items.state === "ready" || items.state === "refreshing"
  const list = createMemo(() => {
    const result = loaded() ? items.latest : undefined
    return result?.sessionID === props.sessionID ? sortSchedules(result.schedules) : []
  })
  const live = createMemo(() => list().filter((item) => item.status !== "done"))
  const upcoming = createMemo(() => nextRun(list()))
  const placement = () => (({ center: "top", start: "top-start", end: "top-end" }) as const)[alignment()]
  const label = () => language.plural("session.schedule.label", live().length)

  const time = (value: number) => formatScheduleTime(language.locale(), value)

  const act = (request: Promise<unknown>) =>
    request
      .catch((error) =>
        showToast({
          title: language.t("common.requestFailed"),
          description: errorMessage(error, language.t("common.requestFailed")),
        }),
      )
      .finally(() => void refetch())

  const call = (item: ScheduleInfo) => ({ scheduleID: item.id })

  return (
    <Show when={list().length > 0}>
      <div
        data-component="session-schedule-pill"
        class="flex min-w-0 shrink"
        classList={{ "-order-1": alignment() === "end", "order-1": alignment() !== "end" }}
      >
        <Popover placement={placement()} gutter={8}>
          <Popover.Trigger
            as="button"
            type="button"
            data-slot="session-schedule-pill"
            aria-label={label()}
            class="pointer-events-auto flex h-7 min-w-0 max-w-full items-center gap-2 rounded-[12px] border-[0.5px] border-v2-border-border-muted bg-v2-background-bg-base ps-2.5 pe-2.5 text-[13px] font-[440] leading-text-compact tracking-[-0.04px] whitespace-nowrap text-v2-text-text-base shadow-[var(--v2-elevation-raised)] outline-none"
          >
            <ClockGlyph size={14} />
            <span class="shrink-0 tabular-nums">{live().length}</span>
            <Show when={upcoming()}>
              {(at) => (
                <span class="min-w-0 truncate text-v2-text-text-muted">
                  {language.t("session.schedule.next", { time: time(at()) })}
                </span>
              )}
            </Show>
          </Popover.Trigger>
          <Popover.Portal>
            <Popover.Content data-slot="session-schedule-panel" aria-label={label()} class="outline-none">
              <div class="flex items-center gap-2 px-2 pt-1 pb-1.5">
                <span class="flex-1 text-[11px] font-[530] uppercase leading-[var(--line-height-tight)] tracking-[0.05px] text-v2-text-text-muted">
                  {language.t("session.schedule.title")}
                </span>
              </div>
              <div data-scrollable class="flex max-h-[320px] flex-col overflow-y-auto px-1 pb-1">
                <Index each={list()}>
                  {(item) => (
                    <ScheduleRow
                      item={item()}
                      onToggle={() =>
                        act(
                          item().status === "paused"
                            ? server.api.experimental.schedule.resume(call(item()))
                            : server.api.experimental.schedule.pause(call(item())),
                        )
                      }
                      onRemove={() => act(server.api.experimental.schedule.delete(call(item())))}
                    />
                  )}
                </Index>
              </div>
            </Popover.Content>
          </Popover.Portal>
        </Popover>
      </div>
    </Show>
  )
}
