import type { TaskQueueInfo, TaskQueueItem } from "@opencode/client/promise"
import { Button } from "@opencode/ui/button"
import { useDialog } from "@opencode/ui/context/dialog"
import { Icon } from "@opencode/ui/icon"
import { IconButton } from "@opencode/ui/icon-button"
import { Loader } from "@opencode/ui/loader"
import { displayName } from "@opencode/ui/project-avatar"
import { TextInput } from "@opencode/ui/text-input"
import { Tooltip } from "@opencode/ui/tooltip"
import { SessionProgressIndicatorV2 } from "@opencode/session-ui/v2/session-progress-indicator-v2"
import { useNavigate } from "@solidjs/router"
import { createEffect, createResource, createSignal, For, on, onCleanup, Show } from "solid-js"
import { createHomeController } from "@/home/model"
import { useLanguage } from "@/runtime/i18n/language"
import { ServerConnection } from "@/runtime/server/registry"
import type { ServerCtx } from "@/runtime/server/runtime"
import { sessionLabel } from "@/session/title"
import { errorMessage } from "@/shell/layout/helpers"
import { showToast } from "@/shell/notifications/toast"
import { sessionHref } from "@/shell/routes/session"
import { DialogCreateQueue } from "./create-dialog"


/** The task queues of the sessions and projects the signed-in member can see, with the tasks waiting in each. */
export function QueuePage() {
  const home = createHomeController()

  return (
    <div
      data-slot="queue-page"
      class="flex min-h-0 flex-1 flex-col border-s-[1.5px] border-v2-border-border-strong bg-v2-background-bg-base"
    >
      <Show when={home.server.focused()}>
        {(conn) => <Show when={home.server.focusedContext()}>{(ctx) => <QueueList conn={conn()} ctx={ctx()} />}</Show>}
      </Show>
    </div>
  )
}

function QueueList(props: { conn: ServerConnection.Any; ctx: ServerCtx }) {
  const language = useLanguage()
  const dialog = useDialog()

  // Each queue comes with its items, and the title of the session it feeds, so one refresh keeps a card consistent.
  const [result, { refetch }] = createResource(
    () => props.conn,
    async (conn) => {
      const api = props.ctx.sdk.api.experimental.taskQueue
      const queues = await api.list({}).catch(() => [])
      const entries = await Promise.all(
        queues.map(async (queue) => {
          const items = await api.items({ queueID: queue.id }).catch(() => [])
          const session = queue.sessionID
            ? (props.ctx.data.session.get(queue.sessionID) ??
              (await props.ctx.sdk.api.session.get({ sessionID: queue.sessionID }).catch(() => undefined)))
            : undefined
          return { queue, items, session: session ? sessionLabel(session) : undefined }
        }),
      )
      return { key: ServerConnection.key(conn), entries }
    },
  )
  // The server announces each queue change; events missed while the stream was down are caught on reconnect.
  let pending: ReturnType<typeof setTimeout> | undefined
  const schedule = () => {
    pending ??= setTimeout(() => {
      pending = undefined
      void refetch()
    }, 300)
  }
  onCleanup(props.ctx.data.on("taskqueue.changed", schedule))
  onCleanup(() => clearTimeout(pending))
  createEffect(
    on(
      () => props.ctx.sdk.connection.status(),
      (status, was) => {
        if (was !== undefined && status === "connected") void refetch()
      },
    ),
  )

  const current = () => {
    const ready = result.state === "ready" || result.state === "refreshing"
    return ready && result.latest?.key === ServerConnection.key(props.conn) ? result.latest : undefined
  }

  const act = (request: Promise<unknown>, fallback?: string) =>
    request
      .catch((error) =>
        showToast({
          title: language.t("common.requestFailed"),
          description: fallback ?? errorMessage(error, language.t("common.requestFailed")),
        }),
      )
      .finally(() => void refetch())

  return (
    <>
      <header class="flex h-12 shrink-0 items-center justify-between border-b-[1.5px] border-v2-border-border-strong px-6">
        <h1 class="text-[15px] font-[530] leading-[var(--line-height-base)] text-v2-text-text-strong">
          {language.t("queue.page.title")}
        </h1>
        <Button
          type="button"
          size="small"
          variant="contrast"
          data-action="queue-create"
          class="!rounded-none"
          onClick={() =>
            dialog.show(() => <DialogCreateQueue conn={props.conn} ctx={props.ctx} onCreated={() => void refetch()} />)
          }
        >
          {language.t("queue.create.button")}
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
          {(data) => (
            <Show
              when={data().entries.length > 0}
              fallback={
                <p class="py-10 text-center text-[13px] text-v2-text-text-muted">{language.t("queue.page.empty")}</p>
              }
            >
              <For each={data().entries}>
                {(entry) => (
                  <QueueCard
                    queue={entry.queue}
                    items={entry.items}
                    session={entry.session}
                    conn={props.conn}
                    ctx={props.ctx}
                    act={act}
                  />
                )}
              </For>
            </Show>
          )}
        </Show>
      </div>
    </>
  )
}

function QueueCard(props: {
  queue: TaskQueueInfo
  items: readonly TaskQueueItem[]
  session?: string
  conn: ServerConnection.Any
  ctx: ServerCtx
  act: (request: Promise<unknown>, fallback?: string) => Promise<unknown>
}) {
  const language = useLanguage()
  const navigate = useNavigate()
  const api = () => props.ctx.sdk.api.experimental.taskQueue
  const [draft, setDraft] = createSignal("")
  const queueID = () => props.queue.id

  const add = () => {
    const prompt = draft().trim()
    if (!prompt) return
    setDraft("")
    void props.act(
      api()
        .enqueue({ queueID: queueID(), prompt })
        .catch((error) => {
          // A full queue is the one failure worth saying in the user's words; the request-failed toast covers the rest.
          if (props.queue.counts.pending + props.queue.counts.running >= props.queue.capacity) {
            setDraft(prompt)
            throw new Error(language.t("queue.full"))
          }
          throw error
        }),
    )
  }

  // Sizes are saved when the field loses focus, so typing "12" never sends "1".
  const resize = (field: "capacity" | "concurrency", raw: string) => {
    const value = Math.floor(Number(raw))
    if (!(value >= 1) || value === props.queue[field]) return
    void props.act(api().update({ queueID: queueID(), [field]: value }))
  }

  const target = () =>
    props.queue.mode === "session"
      ? language.t("queue.target.session", { name: props.session ?? props.queue.sessionID ?? "" })
      : language.t("queue.target.project", {
          name: displayName(
            props.ctx.projects.forDirectory(props.queue.directory ?? "") ?? { worktree: props.queue.directory ?? "" },
          ),
        })

  const finished = () => props.items.some((item) => item.status === "done" || item.status === "failed")
  const open = (sessionID: string) => navigate(sessionHref(ServerConnection.key(props.conn), sessionID))

  return (
    <section data-slot="queue-card" class="flex flex-col border-[1.5px] border-v2-border-border-strong bg-v2-background-bg-base">
      <header class="flex items-start gap-3 border-b border-v2-border-border-muted p-3">
        <div class="flex min-w-0 flex-1 flex-col gap-0.5">
          <div class="flex items-center gap-2">
            <h2 class="min-w-0 truncate text-[13px] font-[530] leading-[var(--line-height-compact)] text-v2-text-text-strong">
              {props.queue.name}
            </h2>
            <Show when={props.queue.status === "paused"}>
              <span
                data-slot="queue-paused"
                class="shrink-0 border border-v2-border-border-muted px-1 text-[11px] leading-[var(--line-height-tight)] text-v2-text-text-muted"
              >
                {language.t("queue.paused")}
              </span>
            </Show>
          </div>
          <span class="truncate text-[12px] leading-[var(--line-height-compact)] text-v2-text-text-muted">
            {target()}
          </span>
          <span class="text-[12px] leading-[var(--line-height-compact)] text-v2-text-text-muted">
            {language.t("queue.counts", props.queue.counts)}
          </span>
        </div>
        <div class="flex shrink-0 items-center gap-3 text-[12px] text-v2-text-text-muted">
          <label class="flex items-center gap-1.5">
            {language.t("queue.capacity")}
            <TextInput
              class="!w-16"
              type="number"
              min="1"
              step="1"
              numeric
              value={String(props.queue.capacity)}
              onChange={(event) => resize("capacity", event.currentTarget.value)}
            />
          </label>
          <Show when={props.queue.mode === "spawn"}>
            <label class="flex items-center gap-1.5">
              {language.t("queue.concurrency")}
              <TextInput
                class="!w-16"
                type="number"
                min="1"
                max={String(props.queue.capacity)}
                step="1"
                numeric
                value={String(props.queue.concurrency)}
                onChange={(event) => resize("concurrency", event.currentTarget.value)}
              />
            </label>
          </Show>
        </div>
        <div class="flex shrink-0 items-center gap-1">
          <Button
            type="button"
            size="small"
            variant="ghost-muted"
            data-action={props.queue.status === "paused" ? "queue-resume" : "queue-pause"}
            onClick={() =>
              void props.act(
                props.queue.status === "paused"
                  ? api().resume({ queueID: queueID() })
                  : api().pause({ queueID: queueID() }),
              )
            }
          >
            {language.t(props.queue.status === "paused" ? "queue.resume" : "queue.pause")}
          </Button>
          <Show when={finished()}>
            <Button
              type="button"
              size="small"
              variant="ghost-muted"
              data-action="queue-clear"
              onClick={() => void props.act(api().clear({ queueID: queueID() }))}
            >
              {language.t("queue.clear")}
            </Button>
          </Show>
          <Tooltip placement="top" value={language.t("queue.delete")}>
            <IconButton
              type="button"
              size="small"
              variant="ghost-muted"
              icon={<Icon name="outline-trash" />}
              aria-label={language.t("queue.delete")}
              data-action="queue-delete"
              onClick={() => void props.act(api().delete({ queueID: queueID() }))}
            />
          </Tooltip>
        </div>
      </header>
      <ul class="flex flex-col p-1">
        <For
          each={props.items}
          fallback={
            <li class="px-2 py-3 text-center text-[12px] text-v2-text-text-muted">{language.t("queue.items.empty")}</li>
          }
        >
          {(item) => (
            <li data-slot="queue-item" data-state={item.status} class="flex items-center gap-2 px-2 py-1.5">
              <span
                class="flex size-4 shrink-0 items-center justify-center"
                role="img"
                aria-label={language.t(`queue.item.${item.status}`)}
              >
                <Show
                  when={item.status === "running"}
                  fallback={
                    <span
                      class="size-1.5 rounded-full"
                      classList={{
                        "border border-v2-border-border-strong": item.status === "pending",
                        "bg-v2-text-text-muted": item.status === "done",
                        "bg-v2-text-text-base": item.status === "failed",
                      }}
                    />
                  }
                >
                  <SessionProgressIndicatorV2 />
                </Show>
              </span>
              <Show
                when={item.sessionID}
                fallback={
                  <span class="min-w-0 flex-1 truncate text-[13px] leading-[var(--line-height-compact)] text-v2-text-text-base">
                    {item.prompt}
                  </span>
                }
              >
                {(sessionID) => (
                  <button
                    type="button"
                    data-action="queue-item-open"
                    class="min-w-0 flex-1 truncate text-start text-[13px] leading-[var(--line-height-compact)] text-v2-text-text-base hover:underline"
                    onClick={() => open(sessionID())}
                  >
                    {item.prompt}
                  </button>
                )}
              </Show>
              <Show when={item.error}>
                <span class="max-w-[40%] shrink-0 truncate text-[12px] text-v2-text-text-muted" title={item.error}>
                  {item.error}
                </span>
              </Show>
              <Show when={item.status === "pending"}>
                <Tooltip placement="top" value={language.t("queue.cancel")}>
                  <IconButton
                    type="button"
                    size="small"
                    variant="ghost-muted"
                    icon={<Icon name="outline-trash" />}
                    aria-label={language.t("queue.cancel")}
                    data-action="queue-item-cancel"
                    onClick={() => void props.act(api().cancel({ queueID: queueID(), itemID: item.id }))}
                  />
                </Tooltip>
              </Show>
            </li>
          )}
        </For>
      </ul>
      <form
        class="flex items-center gap-2 border-t border-v2-border-border-muted p-2"
        onSubmit={(event) => {
          event.preventDefault()
          add()
        }}
      >
        <TextInput
          class="min-w-0 flex-1"
          value={draft()}
          placeholder={language.t("queue.add.placeholder")}
          data-action="queue-add-input"
          onInput={(event) => setDraft(event.currentTarget.value)}
        />
        <Button type="submit" size="small" variant="contrast" class="!rounded-none" disabled={!draft().trim()}>
          {language.t("queue.add")}
        </Button>
      </form>
    </section>
  )
}
