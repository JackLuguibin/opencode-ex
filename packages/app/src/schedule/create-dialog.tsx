import type { ExperimentalScheduleCreateInput, SessionInfo } from "@opencode/client/promise"
import { useQuery } from "@tanstack/solid-query"
import { Button } from "@opencode/ui/button"
import { useDialog } from "@opencode/ui/context/dialog"
import { Dialog, DialogBody, DialogHeader, DialogTitleGroup } from "@opencode/ui/dialog"
import { displayName } from "@opencode/ui/project-avatar"
import { Select } from "@opencode/ui/select"
import { Textarea } from "@opencode/ui/textarea"
import { TextInput } from "@opencode/ui/text-input"
import { createMemo, Index, Match, Show, Switch, type JSX } from "solid-js"
import { Dynamic } from "solid-js/web"
import { createStore } from "solid-js/store"
import { useLanguage } from "@/runtime/i18n/language"
import { homeSessionsQuery } from "@/home/sessions/queries"
import { mergeHomeSessionIndex } from "@/home/sessions"
import type { ServerConnection } from "@/runtime/server/registry"
import type { ServerCtx } from "@/runtime/server/runtime"
import type { LocalProject } from "@/shell/state/layout"
import { sessionLabel } from "@/session/title"
import { errorMessage } from "@/shell/layout/helpers"
import { showToast } from "@/shell/notifications/toast"

const NEW = "new" as const
const KINDS = ["in", "at", "every", "cron"] as const
type Kind = (typeof KINDS)[number]
const UNITS = ["seconds", "minutes", "hours", "days"] as const
type Unit = (typeof UNITS)[number]
const FREQS = ["minute", "hour", "day", "week", "month", "custom"] as const
type Freq = (typeof FREQS)[number]
const WEEKDAYS = [0, 1, 2, 3, 4, 5, 6] as const
const FIELD =
  "flex h-7 items-center rounded-[6px] bg-v2-background-bg-base px-1 shadow-[var(--v2-elevation-button-neutral)] [&_[data-component=select-v2-root]]:!w-full [&_[data-component=select-v2]]:!w-full [&_[data-component=select-v2]]:!max-w-full [&_[data-component=select-v2]]:justify-between"

/** Schedules a prompt for one of the member's sessions: once after a delay or at a time, every interval, or on a cron. */
export function DialogCreateSchedule(props: {
  conn: ServerConnection.Any
  ctx: ServerCtx
  project?: LocalProject
  onCreated: () => void
}) {
  const dialog = useDialog()
  const language = useLanguage()
  // The sessions of the project open in the sidebar, or every session when none is; "new" starts one in that project.
  const directories = () => (props.project ? [props.project.worktree, ...(props.project.sandboxes ?? [])] : undefined)
  // Sessions are only cached once Home has loaded them, so this loads the same index.
  const loaded = useQuery(() => ({
    ...homeSessionsQuery(props.conn, props.ctx),
    enabled: props.ctx.sdk.connection.status() === "connected",
  }))
  const sessions = createMemo(() =>
    mergeHomeSessionIndex(loaded.isPending ? [] : (loaded.data?.() ?? []), props.ctx.data.session.list())
      .filter((item) => !item.parentID && (directories()?.includes(item.location.directory) ?? true))
      .toSorted((a, b) => b.time.updated - a.time.updated),
  )
  // Sessions hang under the project they live in; "new" starts one in the open project. Projects that share a display
  // name are told apart by their path, and sessions that share a title stay separate rows.
  const root = (item: SessionInfo | typeof NEW) => {
    const directory = item === NEW ? props.project?.worktree : item.location.directory
    if (!directory) return ""
    return props.ctx.projects.forDirectory(directory)?.worktree ?? directory
  }
  const options = createMemo<(SessionInfo | typeof NEW)[]>(() => {
    const all = [...(props.project ? [NEW] : []), ...sessions()]
    // Groups appear in the order their first option does, so keep each project's rows together.
    const order = [...new Set(all.map(root))]
    return all.toSorted((a, b) => order.indexOf(root(a)) - order.indexOf(root(b)))
  })
  const projectName = (item: SessionInfo | typeof NEW) => {
    const worktree = root(item)
    const name = displayName(props.ctx.projects.forDirectory(worktree) ?? { worktree })
    const clash = new Set(options().map(root).filter((other) => other && displayName(props.ctx.projects.forDirectory(other) ?? { worktree: other }) === name))
    return clash.size > 1 ? `${name} (${worktree})` : name
  }
  const [form, setForm] = createStore<{
    session?: SessionInfo | typeof NEW
    name: string
    kind: Kind
    amount: string
    unit: Unit
    at: string
    freq: Freq
    minute: string
    time: string
    days: number[]
    monthday: string
    cron: string
    prompt: string
    busy: boolean
  }>({ session: undefined, name: "", kind: "in", amount: "10", unit: "minutes", at: "", freq: "day", minute: "0", time: "09:00", days: [1], monthday: "1", cron: "0 9 * * *", prompt: "", busy: false })

  const session = () => form.session ?? sessions()[0] ?? (props.project ? NEW : undefined)
  // The server reads delays and intervals as `10 minutes`, a time as ISO local time, and a cron as five fields.
  const value = () => {
    if (form.kind === "at") return form.at
    if (form.kind === "cron") return cron()
    return Number(form.amount) > 0 ? `${Number(form.amount)} ${form.unit}` : ""
  }
  // Builds the five cron fields from the picked frequency; "custom" keeps the typed expression.
  const cron = () => {
    const [hour, minute] = form.time.split(":").map(Number)
    const clock = `${minute || 0} ${hour ?? 9}`
    if (form.freq === "minute") return "* * * * *"
    if (form.freq === "hour") return `${Math.min(59, Math.max(0, Number(form.minute) || 0))} * * * *`
    if (form.freq === "day") return `${clock} * * *`
    if (form.freq === "week") return form.days.length ? `${clock} * * ${form.days.toSorted().join(",")}` : ""
    if (form.freq === "month") return `${clock} ${Math.min(31, Math.max(1, Number(form.monthday) || 1))} * *`
    return form.cron.trim()
  }
  const weekday = (day: number) =>
    new Intl.DateTimeFormat(language.locale(), { weekday: "short" }).format(new Date(2024, 0, 7 + day))
  const valid = () => !!session() && !!value() && !!form.prompt.trim()

  const submit = () => {
    const target = session()
    if (!target || !valid() || form.busy) return
    setForm("busy", true)
    const text = value()
    const when: NonNullable<ExperimentalScheduleCreateInput["when"]> =
      form.kind === "in"
        ? { in: text }
        : form.kind === "at"
          ? { at: text }
          : form.kind === "every"
            ? { every: text }
            : { cron: text }
    const name = form.name.trim()
    const prompt = form.prompt.trim()
    const sessionID =
      target === NEW
        ? props.ctx.sdk.api.session
            .create({ title: name || prompt.slice(0, 40), location: { directory: props.project!.worktree } })
            .then((created) => created.id)
        : Promise.resolve(target.id)
    void sessionID
      .then((id) => props.ctx.sdk.api.experimental.schedule.create({ sessionID: id, name: name || undefined, when, prompt }))
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
        <DialogTitleGroup title={language.t("schedule.create.title")} />
      </DialogHeader>
      <DialogBody>
        <form
          class="flex w-full flex-col gap-4 px-4 pb-4"
          onSubmit={(event) => {
            event.preventDefault()
            submit()
          }}
        >
          <Labelled label={language.t("schedule.create.session")}>
            <div class={FIELD}>
              <Select
                options={options()}
                current={session()}
                value={(item) => (item === NEW ? NEW : item.id)}
                label={(item) => (item === NEW ? language.t("schedule.create.session.new") : sessionLabel(item))}
                onSelect={(item) => item && setForm("session", item)}
                groupBy={projectName}
                children={(item) => (
                  <span class="block min-w-0 truncate ps-3">
                    {item === NEW ? language.t("schedule.create.session.new") : sessionLabel(item)}
                  </span>
                )}
                placeholder={language.t("schedule.create.session.empty")}
              />
            </div>
          </Labelled>
          <Labelled native label={language.t("schedule.create.name")}>
            <TextInput class="w-full" value={form.name} onInput={(event) => setForm("name", event.currentTarget.value)} />
          </Labelled>
          <Labelled label={language.t("schedule.create.kind")}>
            <div
              role="radiogroup"
              aria-label={language.t("schedule.create.kind")}
              class="grid grid-cols-4 gap-0.5 rounded-[8px] bg-v2-background-bg-layer-01 p-0.5"
            >
              <Index each={KINDS}>
                {(kind) => (
                  <button
                    type="button"
                    role="radio"
                    aria-checked={form.kind === kind()}
                    data-selected={form.kind === kind() ? "" : undefined}
                    class="h-7 min-w-0 truncate rounded-[6px] px-2 text-[13px] font-[440] leading-[var(--line-height-compact)] text-v2-text-text-muted outline-none focus-visible:outline-2 focus-visible:outline-v2-border-border-focus data-[selected]:bg-v2-background-bg-base data-[selected]:text-v2-text-text-strong data-[selected]:shadow-[var(--v2-elevation-raised)]"
                    onClick={() => setForm("kind", kind())}
                  >
                    {language.t(`schedule.create.kind.${kind()}`)}
                  </button>
                )}
              </Index>
            </div>
          </Labelled>
          <Labelled label={language.t("schedule.create.value")}>
            <Switch>
              <Match when={form.kind === "in" || form.kind === "every"}>
                <div class="flex gap-2">
                  <TextInput
                    class="!w-24"
                    type="number"
                    min="1"
                    step="1"
                    numeric
                    value={form.amount}
                    onInput={(event) => setForm("amount", event.currentTarget.value)}
                  />
                  <div class={`${FIELD} min-w-0 flex-1`}>
                    <Select
                      options={[...UNITS]}
                      current={form.unit}
                      label={(unit) => language.t(`schedule.create.unit.${unit}`)}
                      onSelect={(unit) => unit && setForm("unit", unit)}
                    />
                  </div>
                </div>
              </Match>
              <Match when={form.kind === "at"}>
                <TextInput
                  class="!w-full"
                  type="datetime-local"
                  value={form.at}
                  onInput={(event) => setForm("at", event.currentTarget.value)}
                />
              </Match>
              <Match when={form.kind === "cron"}>
                <div class="flex flex-col gap-2">
                  <div class={FIELD}>
                    <Select
                      options={[...FREQS]}
                      current={form.freq}
                      label={(freq) => language.t(`schedule.create.cron.freq.${freq}`)}
                      onSelect={(freq) => freq && setForm("freq", freq)}
                    />
                  </div>
                  <Show when={form.freq === "hour"}>
                    <Labelled label={language.t("schedule.create.cron.minute")}>
                      <TextInput
                        class="!w-24"
                        type="number"
                        min="0"
                        max="59"
                        numeric
                        value={form.minute}
                        onInput={(event) => setForm("minute", event.currentTarget.value)}
                      />
                    </Labelled>
                  </Show>
                  <Show when={form.freq === "week"}>
                    <div role="group" aria-label={language.t("schedule.create.cron.days")} class="flex gap-1">
                      <Index each={WEEKDAYS}>
                        {(day) => (
                          <button
                            type="button"
                            aria-pressed={form.days.includes(day())}
                            data-selected={form.days.includes(day()) ? "" : undefined}
                            class="h-7 min-w-0 flex-1 truncate rounded-[6px] bg-v2-background-bg-layer-01 px-1 text-[13px] font-[440] leading-[var(--line-height-compact)] text-v2-text-text-muted outline-none focus-visible:outline-2 focus-visible:outline-v2-border-border-focus data-[selected]:bg-v2-background-bg-base data-[selected]:text-v2-text-text-strong data-[selected]:shadow-[var(--v2-elevation-raised)]"
                            onClick={() =>
                              setForm("days", (days) =>
                                days.includes(day()) ? days.filter((item) => item !== day()) : [...days, day()],
                              )
                            }
                          >
                            {weekday(day())}
                          </button>
                        )}
                      </Index>
                    </div>
                  </Show>
                  <Show when={form.freq === "month"}>
                    <Labelled label={language.t("schedule.create.cron.monthday")}>
                      <TextInput
                        class="!w-24"
                        type="number"
                        min="1"
                        max="31"
                        numeric
                        value={form.monthday}
                        onInput={(event) => setForm("monthday", event.currentTarget.value)}
                      />
                    </Labelled>
                  </Show>
                  <Show when={form.freq === "day" || form.freq === "week" || form.freq === "month"}>
                    <Labelled label={language.t("schedule.create.cron.time")}>
                      <TextInput
                        class="!w-32"
                        type="time"
                        value={form.time}
                        onInput={(event) => setForm("time", event.currentTarget.value)}
                      />
                    </Labelled>
                  </Show>
                  <Show
                    when={form.freq === "custom"}
                    fallback={<code class="text-[12px] text-v2-text-text-muted">{cron()}</code>}
                  >
                    <TextInput
                      class="!w-full font-mono"
                      value={form.cron}
                      placeholder={language.t("schedule.create.placeholder.cron")}
                      onInput={(event) => setForm("cron", event.currentTarget.value)}
                    />
                  </Show>
                </div>
              </Match>
            </Switch>
          </Labelled>
          <Labelled native label={language.t("schedule.create.prompt")}>
            <Textarea
              rows={3}
              class="[&_textarea]:max-h-48 [&_textarea]:[field-sizing:content]"
              value={form.prompt}
              onKeyDown={(event) => {
                if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                  event.preventDefault()
                  submit()
                }
              }}
              placeholder={language.t("schedule.create.prompt.placeholder")}
              onInput={(event) => setForm("prompt", event.currentTarget.value)}
            />
          </Labelled>
          <div class="flex items-center justify-end gap-2">
            <Button type="button" variant="ghost" onClick={() => dialog.close()}>
              {language.t("common.cancel")}
            </Button>
            <Button type="submit" variant="contrast" disabled={!valid() || form.busy}>
              {language.t("schedule.create.submit")}
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
      class="flex flex-col gap-1.5 [&_[data-component=textarea-v2]]:!w-full"
    >
      <span class="text-[12px] font-[530] leading-[var(--line-height-compact)] text-v2-text-text-base">{props.label}</span>
      {props.children}
    </Dynamic>
  )
}
