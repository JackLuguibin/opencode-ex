import type { ScheduleInfo } from "@opencode/client/promise"
import { Button } from "@opencode/ui/button"
import { Icon } from "@opencode/ui/icon"
import { IconButton } from "@opencode/ui/icon-button"
import { Tooltip } from "@opencode/ui/tooltip"
import type { JSX } from "solid-js"
import { Show } from "solid-js"
import { useLanguage } from "@/runtime/i18n/language"
import { formatScheduleTime, scheduleTitle, whenParts } from "./schedules"

/** One scheduled prompt with its pause/resume and delete controls; `children` adds a line, e.g. the session it belongs to. */
export function ScheduleRow(props: {
  item: ScheduleInfo
  onToggle: () => void
  onRemove: () => void
  /** Opens the session the schedule belongs to; the text of the row becomes a link. */
  onOpen?: () => void
  children?: JSX.Element
}) {
  const language = useLanguage()
  const time = (value: number) => formatScheduleTime(language.locale(), value)
  const when = () => whenParts(props.item.when)

  return (
    <div
      data-slot="session-schedule-row"
      data-status={props.item.status}
      class="flex shrink-0 items-start gap-2 rounded-none px-1.5 py-1.5"
    >
      <div
        class="flex min-w-0 flex-1 flex-col gap-0.5"
        classList={{ "cursor-pointer": !!props.onOpen }}
        role={props.onOpen ? "link" : undefined}
        tabIndex={props.onOpen ? 0 : undefined}
        onClick={() => props.onOpen?.()}
        onKeyDown={(event) => {
          if (props.onOpen && event.key === "Enter") props.onOpen()
        }}
      >
        <span dir="auto" data-slot="session-schedule-title" class="truncate text-[13px] leading-[var(--line-height-compact)]">
          {scheduleTitle(props.item)}
        </span>
        {props.children}
        <div class="flex min-w-0 flex-wrap gap-x-2 text-[12px] leading-[var(--line-height-compact)] text-v2-text-text-muted">
          <span>{language.t(`session.schedule.when.${when().type}`, { value: when().value })}</span>
          <span data-slot="session-schedule-status">{language.t(`session.schedule.status.${props.item.status}`)}</span>
          <Show when={props.item.status === "active" && props.item.nextDueAt !== undefined}>
            <span>{language.t("session.schedule.next", { time: time(props.item.nextDueAt!) })}</span>
          </Show>
        </div>
        <Show when={props.item.runCount > 0}>
          <div class="flex min-w-0 flex-wrap gap-x-2 text-[12px] leading-[var(--line-height-compact)] text-v2-text-text-faint">
            <span>{language.plural("session.schedule.runs", props.item.runCount)}</span>
            <Show when={props.item.lastFiredAt !== undefined}>
              <span>{language.t("session.schedule.last", { time: time(props.item.lastFiredAt!) })}</span>
            </Show>
          </div>
        </Show>
      </div>
      <Show when={props.item.status !== "done"}>
        <Button type="button" size="small" variant="ghost-muted" onClick={props.onToggle}>
          {language.t(props.item.status === "paused" ? "session.schedule.resume" : "session.schedule.pause")}
        </Button>
      </Show>
      <Tooltip placement="top" value={language.t("common.delete")}>
        <IconButton
          type="button"
          size="small"
          variant="ghost-muted"
          icon={<Icon name="outline-trash" />}
          aria-label={language.t("common.delete")}
          onClick={props.onRemove}
        />
      </Tooltip>
    </div>
  )
}

export function ClockGlyph(props: { size: number }) {
  return (
    <svg viewBox="0 0 16 16" width={props.size} height={props.size} fill="none" aria-hidden="true" class="shrink-0">
      <circle cx="8" cy="8" r="6" stroke="currentColor" stroke-width="1.25" />
      <path d="M8 4.75V8l2.25 1.5" stroke="currentColor" stroke-width="1.25" stroke-linecap="round" />
    </svg>
  )
}
