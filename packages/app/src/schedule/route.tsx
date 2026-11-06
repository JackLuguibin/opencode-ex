import type { ScheduleInfo } from "@opencode/client/promise"
import { Button } from "@opencode/ui/button"
import { useDialog } from "@opencode/ui/context/dialog"
import { Loader } from "@opencode/ui/loader"
import { useNavigate } from "@solidjs/router"
import { createMemo, createResource, Index, onCleanup, Show } from "solid-js"
import { createHomeController } from "@/home/model"
import { useLanguage } from "@/runtime/i18n/language"
import { ServerConnection } from "@/runtime/server/registry"
import type { LocalProject } from "@/shell/state/layout"
import type { ServerCtx } from "@/runtime/server/runtime"
import { DialogCreateSchedule } from "./create-dialog"
import { ScheduleRow } from "@/session/composer/schedule-row"
import { sortSchedules } from "@/session/composer/schedules"
import { sessionLabel } from "@/session/title"
import { errorMessage } from "@/shell/layout/helpers"
import { showToast } from "@/shell/notifications/toast"
import { sessionHref } from "@/shell/routes/session"
import "@/session/composer/schedule-pill.css"

const REFRESH_MS = 15_000

/** Every scheduled prompt of the sessions the signed-in member can see, grouped by session. */
export function SchedulePage() {
  const language = useLanguage()
  const home = createHomeController()

  return (
    <div
      data-slot="schedule-page"
      class="flex min-h-0 flex-1 flex-col border-s-[1.5px] border-v2-border-border-strong bg-v2-background-bg-base"
    >
      <Show when={home.server.focused()}>
        {(conn) => (
          <Show when={home.server.focusedContext()}>
            {(ctx) => (
              <ScheduleList
                conn={conn()}
                ctx={ctx()}
                project={home.project.selected() ?? home.project.newSession()}
                title={language.t("schedule.page.title")}
              />
            )}
          </Show>
        )}
      </Show>
    </div>
  )
}

function ScheduleList(props: { conn: ServerConnection.Any; ctx: ServerCtx; project?: LocalProject; title: string }) {
  const language = useLanguage()
  const navigate = useNavigate()
  const dialog = useDialog()

  // Titles come from the cached sessions, and from the server for the ones this client has not loaded.
  const [result, { refetch }] = createResource(
    () => props.conn,
    async (conn) => {
      const schedules = await props.ctx.sdk.api.experimental.schedule.list({}).catch(() => [])
      const ids = [...new Set(schedules.flatMap((item) => (item.sessionID ? [item.sessionID] : [])))]
      const titles = Object.fromEntries(
        await Promise.all(
          ids.map(async (sessionID) => {
            const session =
              props.ctx.data.session.get(sessionID) ??
              (await props.ctx.sdk.api.session.get({ sessionID }).catch(() => undefined))
            return [sessionID, session ? sessionLabel(session) : sessionID] as const
          }),
        ),
      )
      return { key: ServerConnection.key(conn), schedules, titles }
    },
  )
  const timer = setInterval(() => void refetch(), REFRESH_MS)
  onCleanup(() => clearInterval(timer))

  const loaded = () => result.state === "ready" || result.state === "refreshing"
  const current = () => (loaded() && result.latest?.key === ServerConnection.key(props.conn) ? result.latest : undefined)

  const groups = createMemo(() => {
    const data = current()
    if (!data) return []
    const bySession = Map.groupBy(sortSchedules(data.schedules), (item) => item.sessionID ?? "")
    return [...bySession].map(([sessionID, items]) => ({ sessionID, title: data.titles[sessionID] ?? sessionID, items }))
  })

  const act = (request: Promise<unknown>) =>
    request
      .catch((error) =>
        showToast({
          title: language.t("common.requestFailed"),
          description: errorMessage(error, language.t("common.requestFailed")),
        }),
      )
      .finally(() => void refetch())

  const open = (sessionID: string) => navigate(sessionHref(ServerConnection.key(props.conn), sessionID))

  const toggle = (item: ScheduleInfo) =>
    act(
      item.status === "paused"
        ? props.ctx.sdk.api.experimental.schedule.resume({ scheduleID: item.id })
        : props.ctx.sdk.api.experimental.schedule.pause({ scheduleID: item.id }),
    )

  return (
    <>
      <header class="flex h-12 shrink-0 items-center justify-between border-b-[1.5px] border-v2-border-border-strong px-6">
        <h1 class="text-[15px] font-[530] leading-[var(--line-height-base)] text-v2-text-text-strong">{props.title}</h1>
        <Button
          type="button"
          size="small"
          variant="contrast"
          data-action="schedule-create"
          class="!rounded-none"
          onClick={() => dialog.show(() => <DialogCreateSchedule conn={props.conn} ctx={props.ctx} project={props.project} onCreated={() => void refetch()} />)}
        >
          {language.t("schedule.create.button")}
        </Button>
      </header>
      <div data-scrollable class="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-6 py-5">
      <Show
      when={current()}
      fallback={
        <div class="flex justify-center py-10">
          <Loader />
        </div>
      }
    >
      <Show
        when={groups().length > 0}
        fallback={<p class="py-10 text-center text-[13px] text-v2-text-text-muted">{language.t("schedule.page.empty")}</p>}
      >
        <Index each={groups()}>
          {(group) => (
            <section data-slot="schedule-group" class="flex flex-col gap-1">
              <button
                type="button"
                data-slot="schedule-group-title"
                class="w-fit max-w-full truncate px-1.5 text-start text-[11px] font-[530] uppercase leading-[var(--line-height-tight)] tracking-[0.05px] text-v2-text-text-muted hover:text-v2-text-text-base"
                onClick={() => open(group().sessionID)}
              >
                {group().title}
              </button>
              <div class="flex flex-col border-[1.5px] border-v2-border-border-strong bg-v2-background-bg-base p-1">
                <Index each={group().items}>
                  {(item) => (
                    <ScheduleRow
                      item={item()}
                      onOpen={() => open(group().sessionID)}
                      onToggle={() => toggle(item())}
                      onRemove={() => act(props.ctx.sdk.api.experimental.schedule.delete({ scheduleID: item().id }))}
                    />
                  )}
                </Index>
              </div>
            </section>
          )}
        </Index>
      </Show>
    </Show>
      </div>
    </>
  )
}
