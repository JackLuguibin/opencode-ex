import type { ExperimentalTaskQueueCreateInput, SessionInfo } from "@opencode/client/promise"
import { useQuery } from "@tanstack/solid-query"
import { Button } from "@opencode/ui/button"
import { useDialog } from "@opencode/ui/context/dialog"
import { Dialog, DialogBody, DialogHeader, DialogTitleGroup } from "@opencode/ui/dialog"
import { displayName } from "@opencode/ui/project-avatar"
import { Select } from "@opencode/ui/select"
import { TextInput } from "@opencode/ui/text-input"
import { createMemo, Index, Show, type JSX } from "solid-js"
import { createStore } from "solid-js/store"
import { Dynamic } from "solid-js/web"
import { mergeHomeSessionIndex } from "@/home/sessions"
import { isSharedDirectory } from "@/home/shared/path"
import { useAccountOptional } from "@/identity/gate"
import { homeSessionsQuery } from "@/home/sessions/queries"
import { useLanguage } from "@/runtime/i18n/language"
import type { ServerConnection } from "@/runtime/server/registry"
import type { ServerCtx } from "@/runtime/server/runtime"
import { sessionLabel } from "@/session/title"
import { errorMessage } from "@/shell/layout/helpers"
import { showToast } from "@/shell/notifications/toast"
import { DEFAULT_CAPACITY, DEFAULT_CONCURRENCY } from "./limits"

const MODES = ["session", "spawn"] as const
type Mode = (typeof MODES)[number]
const FIELD =
  "flex h-7 items-center rounded-[6px] bg-v2-background-bg-base px-1 shadow-[var(--v2-elevation-button-neutral)] [&_[data-component=select-v2-root]]:!w-full [&_[data-component=select-v2]]:!w-full [&_[data-component=select-v2]]:!max-w-full [&_[data-component=select-v2]]:justify-between"

/** Makes a queue that feeds one chosen session in turn, or starts a fresh session in a project for every task. */
export function DialogCreateQueue(props: { conn: ServerConnection.Any; ctx: ServerCtx; onCreated: () => void }) {
  const dialog = useDialog()
  const language = useLanguage()
  const account = useAccountOptional()
  const loaded = useQuery(() => ({
    ...homeSessionsQuery(props.conn, props.ctx),
    enabled: props.ctx.sdk.connection.status() === "connected",
  }))
  // The shared space is its own entry beside the projects, never one of them, so a queue cannot start sessions in it.
  const projects = createMemo(() =>
    props.ctx.projects
      .ordered()
      .filter((item) => !isSharedDirectory(account?.session.organizationDirectory, item.worktree)),
  )
  const projectName = (directory: string) => displayName(props.ctx.projects.forDirectory(directory) ?? { worktree: directory })
  // Sessions are listed under their project, in the order the sidebar shows the projects, newest first within each.
  const sessions = createMemo(() => {
    const order = new Map(projects().map((item, index) => [item.worktree, index]))
    return mergeHomeSessionIndex(loaded.isPending ? [] : (loaded.data?.() ?? []), props.ctx.data.session.list())
      .filter((item) => !item.parentID && order.has(item.location.directory))
      .toSorted(
        (a, b) =>
          order.get(a.location.directory)! - order.get(b.location.directory)! || b.time.updated - a.time.updated,
      )
  })
  const [form, setForm] = createStore<{
    name: string
    mode: Mode
    session?: SessionInfo
    project?: string
    capacity: string
    concurrency: string
    busy: boolean
  }>({
    name: "",
    mode: "session",
    session: undefined,
    project: undefined,
    capacity: String(DEFAULT_CAPACITY),
    concurrency: String(DEFAULT_CONCURRENCY),
    busy: false,
  })

  const session = () => form.session ?? sessions()[0]
  const project = () => form.project ?? projects()[0]?.worktree
  const capacity = () => Math.max(1, Math.floor(Number(form.capacity)) || 0)
  const concurrency = () => Math.max(1, Math.floor(Number(form.concurrency)) || 0)
  const valid = () =>
    !!form.name.trim() &&
    capacity() >= 1 &&
    (form.mode === "session" ? !!session() : !!project() && concurrency() >= 1 && concurrency() <= capacity())

  const submit = () => {
    if (!valid() || form.busy) return
    setForm("busy", true)
    const input: ExperimentalTaskQueueCreateInput =
      form.mode === "session"
        ? { name: form.name.trim(), mode: "session", sessionID: session()!.id, capacity: capacity() }
        : {
            name: form.name.trim(),
            mode: "spawn",
            directory: project()!,
            capacity: capacity(),
            concurrency: concurrency(),
          }
    void props.ctx.sdk.api.experimental.taskQueue
      .create(input)
      .then(() => {
        dialog.close()
        props.onCreated()
      })
      .catch((error) => {
        setForm("busy", false)
        showToast({
          title: language.t("common.requestFailed"),
          description: errorMessage(error, language.t("common.requestFailed")),
        })
      })
  }

  return (
    <Dialog fit>
      <DialogHeader>
        <DialogTitleGroup title={language.t("queue.create.title")} />
      </DialogHeader>
      <DialogBody>
        <form
          class="flex w-full flex-col gap-4 px-4 pb-4"
          onSubmit={(event) => {
            event.preventDefault()
            submit()
          }}
        >
          <Labelled native label={language.t("queue.create.name")}>
            <TextInput class="w-full" value={form.name} onInput={(event) => setForm("name", event.currentTarget.value)} />
          </Labelled>
          <Labelled label={language.t("queue.create.mode")}>
            <div
              role="radiogroup"
              aria-label={language.t("queue.create.mode")}
              class="grid grid-cols-2 gap-0.5 rounded-[8px] bg-v2-background-bg-layer-01 p-0.5"
            >
              <Index each={MODES}>
                {(mode) => (
                  <button
                    type="button"
                    role="radio"
                    aria-checked={form.mode === mode()}
                    data-selected={form.mode === mode() ? "" : undefined}
                    class="h-7 min-w-0 truncate rounded-[6px] px-2 text-[13px] font-[440] leading-[var(--line-height-compact)] text-v2-text-text-muted outline-none focus-visible:outline-2 focus-visible:outline-v2-border-border-focus data-[selected]:bg-v2-background-bg-base data-[selected]:text-v2-text-text-strong data-[selected]:shadow-[var(--v2-elevation-raised)]"
                    onClick={() => setForm("mode", mode())}
                  >
                    {language.t(`queue.mode.${mode()}`)}
                  </button>
                )}
              </Index>
            </div>
          </Labelled>
          <Show
            when={form.mode === "session"}
            fallback={
              <Labelled label={language.t("queue.create.project")}>
                <div class={FIELD}>
                  <Select
                    options={projects().map((item) => item.worktree)}
                    current={project()}
                    label={projectName}
                    onSelect={(worktree) => worktree && setForm("project", worktree)}
                    placeholder={language.t("queue.create.project.empty")}
                  />
                </div>
              </Labelled>
            }
          >
            <Labelled label={language.t("queue.create.session")}>
              <div class={FIELD}>
                <Select
                  options={sessions()}
                  current={session()}
                  value={(item) => item.id}
                  label={sessionLabel}
                  groupBy={(item) => projectName(item.location.directory)}
                  onSelect={(item) => item && setForm("session", item)}
                  placeholder={language.t("queue.create.session.empty")}
                >
                  {(item) => <span class="ps-3">{sessionLabel(item)}</span>}
                </Select>
              </div>
            </Labelled>
          </Show>
          <div class="flex gap-3">
            <Labelled native label={language.t("queue.create.capacity")}>
              <TextInput
                class="!w-28"
                type="number"
                min="1"
                step="1"
                numeric
                value={form.capacity}
                onInput={(event) => setForm("capacity", event.currentTarget.value)}
              />
            </Labelled>
            <Show when={form.mode === "spawn"}>
              <Labelled native label={language.t("queue.create.concurrency")}>
                <TextInput
                  class="!w-28"
                  type="number"
                  min="1"
                  max={String(capacity())}
                  step="1"
                  numeric
                  value={form.concurrency}
                  onInput={(event) => setForm("concurrency", event.currentTarget.value)}
                />
              </Labelled>
            </Show>
          </div>
          <div class="flex items-center justify-end gap-2">
            <Button type="button" variant="ghost" onClick={() => dialog.close()}>
              {language.t("common.cancel")}
            </Button>
            <Button type="submit" variant="contrast" disabled={!valid() || form.busy}>
              {language.t("queue.create.submit")}
            </Button>
          </div>
        </form>
      </DialogBody>
    </Dialog>
  )
}

// A `<label>` forwards every click inside it to its first control, which re-toggles a dropdown the moment the mouse is
// released over it, so only fields that are a single plain input use one.
function Labelled(props: { label: string; native?: boolean; children: JSX.Element }) {
  return (
    <Dynamic
      component={props.native ? "label" : "div"}
      role={props.native ? undefined : "group"}
      aria-label={props.native ? undefined : props.label}
      class="flex flex-col gap-1.5"
    >
      <span class="text-[12px] font-[530] leading-[var(--line-height-compact)] text-v2-text-text-base">{props.label}</span>
      {props.children}
    </Dynamic>
  )
}
