import { createEffect, createMemo, createSignal, For, on, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { Button } from "@opencode/ui/button"
import { Icon } from "@opencode/ui/icon"
import { Dialog, DialogBody, DialogHeader, DialogTitleGroup } from "@opencode/ui/dialog"
import { Loader } from "@opencode/ui/loader"
import { TextInput } from "@opencode/ui/text-input"
import { useLanguage } from "@/runtime/i18n/language"
import type { ServerConnection } from "@/runtime/server/registry"
import {
  accountFetch,
  AccountError,
  type AccountUsageMessage,
  type AccountUsageOrganization,
  type AccountUsageReport,
  type AccountUsageSession,
  type AccountUsageTotals,
  type UsageGroupBy,
} from "./api"
import "./usage.css"

const DAY = 24 * 60 * 60 * 1000
const ranges = [7, 30, 90] as const
const groupings = ["user", "model", "project", "session"] as const satisfies ReadonlyArray<UsageGroupBy>
const PAGE = 20

const money = (value: number) => `$${value.toFixed(value > 0 && value < 0.01 ? 4 : 2)}`
const compact = new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 })
const tokensOf = (totals: AccountUsageTotals) =>
  totals.tokensInput + totals.tokensOutput + totals.tokensReasoning + totals.tokensCacheRead + totals.tokensCacheWrite

/** A message's text for a preview: its own text, or the text parts of its content, else a short JSON. */
function preview(data: unknown) {
  const message = data as { text?: unknown; content?: unknown } | undefined
  if (typeof message?.text === "string") return message.text
  if (Array.isArray(message?.content)) {
    const text = message.content
      .map((part: { text?: unknown }) => (typeof part?.text === "string" ? part.text : ""))
      .filter(Boolean)
      .join("\n")
    if (text) return text
  }
  return JSON.stringify(data ?? null).slice(0, 400)
}

/**
 * Usage of an organization (its admins see everyone, a member only themselves) or, with `platform`, of every
 * organization. It reads the sessions that execution layers copy to the shared database.
 */
export function UsagePanel(props: {
  server: ServerConnection.Http
  /** The organization to report on; ignored with `platform`. */
  organizationID?: string
  platform?: boolean
  /** Shown above the figures; a member's own page says it is their own. */
  description?: string
}) {
  const language = useLanguage()
  const [state, setState] = createStore({
    days: 30 as (typeof ranges)[number],
    groupBy: "user" as UsageGroupBy,
    report: undefined as AccountUsageReport | undefined,
    organizations: [] as AccountUsageOrganization[],
    sessions: [] as AccountUsageSession[],
    sessionsTotal: 0,
    search: "",
    open: undefined as AccountUsageSession | undefined,
    messages: [] as AccountUsageMessage[],
    loading: true,
    sessionsLoading: false,
    messagesLoading: false,
    unavailable: false,
    error: "",
  })
  // A slow answer to an old request must not overwrite the answer to the current one.
  const [generation, setGeneration] = createSignal(0)

  const range = () => {
    // Whole local days: from the start of the first one to the start of the day after today.
    const end = new Date()
    end.setHours(24, 0, 0, 0)
    return { from: end.getTime() - state.days * DAY, to: end.getTime(), tzOffset: -new Date().getTimezoneOffset() }
  }
  const base = () => `/api/organization/${encodeURIComponent(props.organizationID ?? "")}/usage`
  const get = <T,>(path: string, query: Record<string, string | number | undefined>) => {
    const search = new URLSearchParams()
    for (const [key, value] of Object.entries(query)) if (value !== undefined && value !== "") search.set(key, String(value))
    return accountFetch<T>({ url: props.server.http.url, password: props.server.http.password, path: `${path}?${search}` })
  }
  const fail = (error: unknown) => {
    // Without the shared database the server answers 400: there is nothing to show, which is not a failure.
    if (error instanceof AccountError && error.status === 400) return setState({ unavailable: true })
    if (error instanceof AccountError && error.status === 403) return setState("error", language.t("account.error.forbidden"))
    setState("error", language.t("account.error.connection"))
  }

  const load = async () => {
    const id = generation() + 1
    setGeneration(id)
    setState({ loading: true, error: "", unavailable: false, open: undefined, messages: [] })
    const { from, to, tzOffset } = range()
    try {
      if (props.platform) {
        const result = await get<{ items: AccountUsageOrganization[] }>("/api/auth/usage/organizations", { from, to })
        if (generation() === id) setState({ organizations: result.items, report: undefined })
      } else {
        const report = await get<AccountUsageReport>(base(), { from, to, tzOffset, groupBy: state.groupBy })
        if (generation() === id) setState({ report, organizations: [] })
      }
    } catch (error) {
      if (generation() === id) fail(error)
    } finally {
      if (generation() === id) setState("loading", false)
    }
    if (!props.platform && generation() === id) await loadSessions(0)
  }

  const loadSessions = async (offset: number) => {
    const id = generation()
    setState("sessionsLoading", true)
    const { from, to } = range()
    try {
      const result = await get<{ total: number; items: AccountUsageSession[] }>(`${base()}/sessions`, {
        from,
        to,
        search: state.search.trim(),
        limit: PAGE,
        offset,
      })
      if (generation() !== id) return
      setState({
        sessions: offset === 0 ? result.items : [...state.sessions, ...result.items],
        sessionsTotal: result.total,
      })
    } catch (error) {
      if (generation() === id) fail(error)
    } finally {
      if (generation() === id) setState("sessionsLoading", false)
    }
  }

  const show = async (session: AccountUsageSession) => {
    if (state.open?.id === session.id) return setState({ open: undefined, messages: [] })
    setState({ open: session, messages: [], messagesLoading: true })
    try {
      const result = await get<{ items: AccountUsageMessage[] }>(
        `${base()}/sessions/${encodeURIComponent(session.id)}/messages`,
        { limit: 100 },
      )
      if (state.open?.id === session.id) setState("messages", result.items)
    } catch (error) {
      fail(error)
    } finally {
      setState("messagesLoading", false)
    }
  }

  createEffect(on(() => [props.organizationID, props.platform, state.days, state.groupBy] as const, load))

  const totals = createMemo<AccountUsageTotals | undefined>(() => {
    if (state.report) return state.report.totals
    if (!props.platform || state.organizations.length === 0) return undefined
    const sum = (pick: (item: AccountUsageOrganization) => number) =>
      state.organizations.reduce((total, item) => total + pick(item), 0)
    return {
      cost: sum((item) => item.cost),
      tokensInput: sum((item) => item.tokensInput),
      tokensOutput: sum((item) => item.tokensOutput),
      tokensReasoning: sum((item) => item.tokensReasoning),
      tokensCacheRead: sum((item) => item.tokensCacheRead),
      tokensCacheWrite: sum((item) => item.tokensCacheWrite),
      calls: sum((item) => item.calls),
      sessions: sum((item) => item.sessions),
      users: sum((item) => item.users),
    }
  })
  // Every day of the range, so a quiet day is an empty bar and not a gap in the axis.
  const series = createMemo(() => {
    const days = new Map((state.report?.days ?? []).map((day) => [day.day, day]))
    const pad = (value: number) => String(value).padStart(2, "0")
    return Array.from({ length: state.days }, (_, index) => {
      const date = new Date(range().from + index * DAY + DAY / 2)
      const key = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
      return days.get(key) ?? { day: key, cost: 0, tokens: 0, calls: 0 }
    })
  })
  const peak = createMemo(() => Math.max(0, ...series().map((day) => day.cost)))
  const empty = () => !state.loading && !state.unavailable && (totals()?.calls ?? 0) === 0

  return (
    <section data-component="usage-panel" aria-label={language.t("account.usage.title")}>
      <header class="usage-head">
        <Show when={props.description !== ""}>
          <p class="usage-description">{props.description ?? language.t("account.usage.description")}</p>
        </Show>
        <div class="usage-controls">
          <div class="usage-range" role="group" aria-label={language.t("account.usage.range")}>
            <For each={ranges}>
              {(days) => (
                <button
                  type="button"
                  data-active={state.days === days}
                  aria-pressed={state.days === days}
                  onClick={() => setState("days", days)}
                >
                  {language.t("account.usage.days", { count: days })}
                </button>
              )}
            </For>
          </div>
          <Button type="button" variant="ghost" icon="reset" onClick={load}>
            {language.t("account.usage.refresh")}
          </Button>
        </div>
      </header>

      <Show when={state.error}>
        <p class="usage-error" role="alert">
          {state.error}
        </p>
      </Show>
      <Show when={state.loading}>
        <div class="usage-loading">
          <Loader />
        </div>
      </Show>
      <Show when={state.unavailable}>
        <p class="usage-empty">{language.t("account.usage.unavailable")}</p>
      </Show>
      <Show when={empty()}>
        <p class="usage-empty">{language.t("account.usage.empty")}</p>
      </Show>

      <Show when={!state.loading && !state.unavailable && totals() && (totals()?.calls ?? 0) > 0}>
        <div class="usage-stats">
          <article>
            <span>{language.t("account.usage.cost")}</span>
            <strong>{money(totals()!.cost)}</strong>
          </article>
          <article>
            <span>{language.t("account.usage.tokens")}</span>
            <strong>{compact.format(tokensOf(totals()!))}</strong>
          </article>
          <article>
            <span>{language.t("account.usage.calls")}</span>
            <strong>{compact.format(totals()!.calls)}</strong>
          </article>
          <article>
            <span>{language.t("account.usage.sessions")}</span>
            <strong>{compact.format(totals()!.sessions)}</strong>
          </article>
          <article>
            <span>{language.t("account.usage.users")}</span>
            <strong>{compact.format(totals()!.users)}</strong>
          </article>
        </div>

        <Show when={state.report}>
          {(report) => (
            <>
              <section class="usage-section">
                <h3>{language.t("account.usage.byDay")}</h3>
                <svg
                  class="usage-chart"
                  viewBox={`0 0 ${series().length * 16} 100`}
                  preserveAspectRatio="none"
                  role="img"
                  aria-label={language.t("account.usage.byDay")}
                >
                  <For each={series()}>
                    {(day, index) => {
                      const height = () => (peak() === 0 ? 0 : Math.max((day.cost / peak()) * 96, day.cost > 0 ? 1 : 0))
                      return (
                        <rect x={index() * 16 + 2} y={100 - height()} width={12} height={height()} rx={2}>
                          <title>{`${day.day}: ${money(day.cost)} · ${compact.format(day.tokens)} ${language.t("account.usage.tokens")}`}</title>
                        </rect>
                      )
                    }}
                  </For>
                </svg>
                <div class="usage-axis">
                  <span>{series()[0]?.day}</span>
                  <span>{series().at(-1)?.day}</span>
                </div>
              </section>

              <section class="usage-section">
                <div class="usage-section-head">
                  <h3>{language.t("account.usage.breakdown")}</h3>
                  <div class="usage-range" role="group" aria-label={language.t("account.usage.groupBy")}>
                    <For each={groupings}>
                      {(item) => (
                        <button
                          type="button"
                          data-active={state.groupBy === item}
                          aria-pressed={state.groupBy === item}
                          onClick={() => setState("groupBy", item)}
                        >
                          {language.t(`account.usage.group.${item}`)}
                        </button>
                      )}
                    </For>
                  </div>
                </div>
                <div class="usage-table-scroll" data-scrollable>
                  <table class="usage-table">
                    <thead>
                      <tr>
                        <th scope="col">{language.t(`account.usage.group.${state.groupBy}`)}</th>
                        <th scope="col">{language.t("account.usage.cost")}</th>
                        <th scope="col">{language.t("account.usage.tokens")}</th>
                        <th scope="col">{language.t("account.usage.calls")}</th>
                      </tr>
                    </thead>
                    <tbody>
                      <For each={report().groups}>
                        {(group) => (
                          <tr>
                            <td>{group.label || language.t("account.usage.unknown")}</td>
                            <td>{money(group.cost)}</td>
                            <td>{compact.format(tokensOf(group))}</td>
                            <td>{compact.format(group.calls)}</td>
                          </tr>
                        )}
                      </For>
                    </tbody>
                  </table>
                </div>
                <p class="usage-note">{language.t("account.usage.note")}</p>
              </section>
            </>
          )}
        </Show>

        <Show when={props.platform}>
          <section class="usage-section">
            <h3>{language.t("account.usage.organizations")}</h3>
            <div class="usage-table-scroll" data-scrollable>
              <table class="usage-table">
                <thead>
                  <tr>
                    <th scope="col">{language.t("account.usage.organization")}</th>
                    <th scope="col">{language.t("account.usage.cost")}</th>
                    <th scope="col">{language.t("account.usage.tokens")}</th>
                    <th scope="col">{language.t("account.usage.calls")}</th>
                    <th scope="col">{language.t("account.usage.users")}</th>
                  </tr>
                </thead>
                <tbody>
                  <For each={state.organizations}>
                    {(item) => (
                      <tr>
                        <td>{item.name}</td>
                        <td>{money(item.cost)}</td>
                        <td>{compact.format(tokensOf(item))}</td>
                        <td>{compact.format(item.calls)}</td>
                        <td>{compact.format(item.users)}</td>
                      </tr>
                    )}
                  </For>
                </tbody>
              </table>
            </div>
          </section>
        </Show>
      </Show>

      <Show when={!props.platform && !state.unavailable}>
        <section class="usage-section">
          <div class="usage-section-head">
            <h3>{language.t("account.usage.sessionsTitle")}</h3>
            <div class="usage-search">
              <TextInput
                type="search"
                leadingIcon={<Icon name="magnifying-glass" />}
                aria-label={language.t("account.usage.search")}
                placeholder={language.t("account.usage.search")}
                value={state.search}
                onInput={(event) => setState("search", event.currentTarget.value)}
                onKeyDown={(event: KeyboardEvent) => event.key === "Enter" && loadSessions(0)}
              />
            </div>
          </div>
          <Show
            when={state.sessions.length > 0}
            fallback={
              <Show when={!state.sessionsLoading}>
                <p class="usage-empty">{language.t("account.usage.sessionsEmpty")}</p>
              </Show>
            }
          >
            <div class="usage-table-scroll" data-scrollable>
              <table class="usage-table" data-rows="interactive">
                <thead>
                  <tr>
                    <th scope="col">{language.t("account.usage.session")}</th>
                    <th scope="col">{language.t("account.usage.holder")}</th>
                    <th scope="col">{language.t("account.usage.group.project")}</th>
                    <th scope="col">{language.t("account.usage.cost")}</th>
                    <th scope="col">{language.t("account.usage.tokens")}</th>
                    <th scope="col">{language.t("account.usage.updated")}</th>
                  </tr>
                </thead>
                <tbody>
                  <For each={state.sessions}>
                    {(session) => (
                      <>
                        <tr
                          tabIndex={0}
                          aria-expanded={state.open?.id === session.id}
                          data-open={state.open?.id === session.id}
                          onClick={() => show(session)}
                          onKeyDown={(event) => (event.key === "Enter" || event.key === " ") && show(session)}
                        >
                          <td>{session.title || session.id}</td>
                          <td>{session.holder ?? "—"}</td>
                          <td>{session.project ?? "—"}</td>
                          <td>{money(session.cost)}</td>
                          <td>{compact.format(session.tokens)}</td>
                          <td>{new Date(session.updated).toLocaleString()}</td>
                        </tr>
                        <Show when={state.open?.id === session.id}>
                          <tr class="usage-messages-row">
                            <td colSpan={6}>
                              <Show when={!state.messagesLoading} fallback={<Loader />}>
                                <ol class="usage-messages" aria-label={language.t("account.usage.messages")}>
                                  <For each={state.messages}>
                                    {(message) => (
                                      <li data-type={message.type}>
                                        <div class="usage-message-meta">
                                          <span>{message.type}</span>
                                          <span>{message.user ?? ""}</span>
                                          <span>{new Date(message.created).toLocaleString()}</span>
                                          <Show when={message.cost !== null}>
                                            <span>{money(message.cost ?? 0)}</span>
                                          </Show>
                                        </div>
                                        <pre>{preview(message.data)}</pre>
                                      </li>
                                    )}
                                  </For>
                                </ol>
                              </Show>
                            </td>
                          </tr>
                        </Show>
                      </>
                    )}
                  </For>
                </tbody>
              </table>
            </div>
            <Show when={state.sessions.length < state.sessionsTotal}>
              <Button type="button" variant="ghost" onClick={() => loadSessions(state.sessions.length)}>
                {language.t("account.usage.more")}
              </Button>
            </Show>
          </Show>
        </section>
      </Show>
    </section>
  )
}

/** A member's own usage in the organization they are in, from the account menu. */
export function UsageDialog(props: { server: ServerConnection.Http; organizationID: string; admin: boolean }) {
  const language = useLanguage()
  return (
    <Dialog fit>
      <DialogHeader>
        <DialogTitleGroup
          title={language.t(props.admin ? "account.usage.title" : "account.usage.navOwn")}
          description=""
        />
      </DialogHeader>
      <DialogBody class="flex flex-col gap-4 px-4 pb-4">
        <UsagePanel
          server={props.server}
          organizationID={props.organizationID}
          description={language.t(props.admin ? "account.usage.description" : "account.usage.descriptionOwn")}
        />
      </DialogBody>
    </Dialog>
  )
}
