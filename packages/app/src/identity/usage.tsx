import { createEffect, createMemo, For, on, Show } from "solid-js"
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
// Small pages keep the whole report on one screen, so nothing has to scroll.
const SIZE = { groups: 5, organizations: 8, sessions: 8, messages: 4 } as const

const when = new Intl.DateTimeFormat(undefined, { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })
const money = (value: number) => `$${value.toFixed(value > 0 && value < 0.01 ? 4 : 2)}`
const compact = new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 })
/** The last folder of a path, for a project that has no name; the whole path stays in the tooltip. */
const leaf = (value: string | null | undefined) => value?.split(/[\\/]/).filter(Boolean).at(-1) ?? value ?? ""
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

/** Previous and next, with the page when the total is known. */
function Pager(props: {
  page: number
  /** Rows on every page but the last; with `total` the pages are counted, without it `hasNext` says if there are more. */
  size: number
  total?: number
  hasNext?: boolean
  onPage: (page: number) => void
}) {
  const language = useLanguage()
  const pages = () => (props.total === undefined ? undefined : Math.max(1, Math.ceil(props.total / props.size)))
  const last = () => {
    const count = pages()
    return count === undefined ? !props.hasNext : props.page + 1 >= count
  }
  return (
    <Show when={props.page > 0 || !last()}>
      <nav class="usage-pager" aria-label={language.t("account.usage.pages")}>
        <span class="usage-pager-total">
          {props.total === undefined ? "" : language.plural("account.usage.sessionsCount", props.total)}
        </span>
        <div class="usage-pager-controls">
          <Button
            type="button"
            variant="ghost"
            icon="chevron-left"
            disabled={props.page === 0}
            aria-label={language.t("account.usage.prev")}
            onClick={() => props.onPage(props.page - 1)}
          />
          <span class="usage-pager-page">
            {pages() === undefined
              ? language.t("account.usage.pageOnly", { page: props.page + 1 })
              : language.t("account.usage.page", { page: props.page + 1, pages: pages()! })}
          </span>
          <Button
            type="button"
            variant="ghost"
            icon="chevron-right"
            disabled={last()}
            aria-label={language.t("account.usage.next")}
            onClick={() => props.onPage(props.page + 1)}
          />
        </div>
      </nav>
    </Show>
  )
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
    tab: "overview" as "overview" | "sessions",
    report: undefined as AccountUsageReport | undefined,
    organizations: [] as AccountUsageOrganization[],
    groupPage: 0,
    organizationPage: 0,
    sessions: [] as AccountUsageSession[],
    sessionsTotal: 0,
    sessionPage: 0,
    search: "",
    open: undefined as AccountUsageSession | undefined,
    messages: [] as AccountUsageMessage[],
    messagePage: 0,
    messagesMore: false,
    loading: true,
    sessionsLoading: false,
    messagesLoading: false,
    unavailable: false,
    error: "",
  })
  // A slow answer to an old request must not overwrite the answer to the current one.
  let reportRun = 0
  let sessionRun = 0
  let messageRun = 0

  const range = () => {
    // Whole local days: from the start of the first one to the start of the day after today.
    const end = new Date()
    end.setHours(24, 0, 0, 0)
    return { from: end.getTime() - state.days * DAY, to: end.getTime(), tzOffset: -new Date().getTimezoneOffset() }
  }
  const base = () => `/api/organization/${encodeURIComponent(props.organizationID ?? "")}/usage`
  const get = <T,>(path: string, query: Record<string, string | number | undefined>) => {
    const search = new URLSearchParams()
    for (const [key, value] of Object.entries(query))
      if (value !== undefined && value !== "") search.set(key, String(value))
    return accountFetch<T>({ url: props.server.http.url, password: props.server.http.password, path: `${path}?${search}` })
  }
  const fail = (error: unknown) => {
    // Without the shared database the server answers 400: there is nothing to show, which is not a failure.
    if (error instanceof AccountError && error.status === 400) return setState({ unavailable: true })
    if (error instanceof AccountError && error.status === 403)
      return setState("error", language.t("account.error.forbidden"))
    setState("error", language.t("account.error.connection"))
  }

  const loadReport = async () => {
    const run = ++reportRun
    setState({ loading: true, error: "", unavailable: false, groupPage: 0, organizationPage: 0 })
    const { from, to, tzOffset } = range()
    try {
      if (props.platform) {
        const result = await get<{ items: AccountUsageOrganization[] }>("/api/auth/usage/organizations", { from, to })
        if (reportRun === run) setState({ organizations: result.items, report: undefined })
      } else {
        const report = await get<AccountUsageReport>(base(), { from, to, tzOffset, groupBy: state.groupBy })
        if (reportRun === run) setState({ report, organizations: [] })
      }
    } catch (error) {
      if (reportRun === run) fail(error)
    } finally {
      if (reportRun === run) setState("loading", false)
    }
  }

  const loadSessions = async (page: number) => {
    const run = ++sessionRun
    setState({ sessionsLoading: true, sessionPage: page })
    const { from, to } = range()
    try {
      const result = await get<{ total: number; items: AccountUsageSession[] }>(`${base()}/sessions`, {
        from,
        to,
        search: state.search.trim(),
        limit: SIZE.sessions,
        offset: page * SIZE.sessions,
      })
      if (sessionRun === run) setState({ sessions: result.items, sessionsTotal: result.total })
    } catch (error) {
      if (sessionRun === run) fail(error)
    } finally {
      if (sessionRun === run) setState("sessionsLoading", false)
    }
  }

  const loadMessages = async (session: AccountUsageSession, page: number) => {
    const run = ++messageRun
    setState({ messagesLoading: true, messagePage: page })
    try {
      // One more than a page, to know whether there is a next one.
      const result = await get<{ items: AccountUsageMessage[] }>(
        `${base()}/sessions/${encodeURIComponent(session.id)}/messages`,
        { limit: SIZE.messages + 1, offset: page * SIZE.messages },
      )
      if (messageRun === run)
        setState({ messages: result.items.slice(0, SIZE.messages), messagesMore: result.items.length > SIZE.messages })
    } catch (error) {
      if (messageRun === run) fail(error)
    } finally {
      if (messageRun === run) setState("messagesLoading", false)
    }
  }

  const open = (session: AccountUsageSession) => {
    setState({ open: session, messages: [], messagesMore: false })
    void loadMessages(session, 0)
  }

  createEffect(on(() => [props.organizationID, props.platform, state.days, state.groupBy] as const, loadReport))
  // The session list does not depend on how the breakdown is grouped.
  createEffect(
    on(
      () => [props.organizationID, props.platform, state.days] as const,
      () => {
        setState({ open: undefined, messages: [] })
        if (!props.platform) void loadSessions(0)
      },
    ),
  )

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
  const groups = createMemo(() => state.report?.groups ?? [])
  // A group's share of the biggest one, for the bar behind its cost.
  const shareOf = (cost: number) => {
    const top = Math.max(0, ...groups().map((group) => group.cost))
    return top === 0 ? 0 : Math.round((cost / top) * 100)
  }
  const page = <T,>(items: ReadonlyArray<T>, index: number, size: number) => items.slice(index * size, (index + 1) * size)
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
                  {language.plural("account.usage.days", days)}
                </button>
              )}
            </For>
          </div>
          <Button
            type="button"
            variant="ghost"
            icon="reset"
            onClick={() => {
              void loadReport()
              if (!props.platform) void loadSessions(state.sessionPage)
            }}
          >
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

        <Show when={!props.platform}>
          <div class="usage-range usage-tabs" role="tablist" aria-label={language.t("account.usage.title")}>
            <For each={["overview", "sessions"] as const}>
              {(tab) => (
                <button
                  type="button"
                  role="tab"
                  data-active={state.tab === tab}
                  aria-selected={state.tab === tab}
                  onClick={() => setState("tab", tab)}
                >
                  {language.t(`account.usage.tab.${tab}`)}
                </button>
              )}
            </For>
          </div>
        </Show>

        <Show when={!props.platform && state.tab === "overview" && state.report}>
          <div class="usage-overview">
            <section class="usage-section">
              <h3>{language.t("account.usage.byDay")}</h3>
              <div class="usage-chart-box">
                <span class="usage-peak">{money(peak())}</span>
                <svg
                  class="usage-chart"
                  viewBox={`0 0 ${series().length * 16} 100`}
                  preserveAspectRatio="none"
                  role="img"
                  aria-label={language.t("account.usage.byDay")}
                >
                  <line x1="0" x2={series().length * 16} y1="0.5" y2="0.5" class="usage-grid" />
                  <line x1="0" x2={series().length * 16} y1="50" y2="50" class="usage-grid" />
                  <For each={series()}>
                    {(day, index) => {
                      const height = () => (peak() === 0 ? 0 : Math.max((day.cost / peak()) * 96, day.cost > 0 ? 1.5 : 0))
                      return (
                        <rect x={index() * 16 + 2} y={100 - height()} width={12} height={height()} rx={2}>
                          <title>{`${day.day}: ${money(day.cost)} · ${compact.format(day.tokens)} ${language.t("account.usage.tokens")} · ${day.calls} ${language.t("account.usage.calls")}`}</title>
                        </rect>
                      )
                    }}
                  </For>
                </svg>
              </div>
              <div class="usage-axis">
                <span>{series()[0]?.day}</span>
                <span>{series()[Math.floor(series().length / 2)]?.day}</span>
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
                      <th scope="col" class="usage-num usage-cost">{language.t("account.usage.cost")}</th>
                      <th scope="col" class="usage-num">{language.t("account.usage.tokens")}</th>
                      <th scope="col" class="usage-num">{language.t("account.usage.calls")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    <For each={page(groups(), state.groupPage, SIZE.groups)}>
                      {(group) => (
                        <tr>
                          <td class="usage-col-title" title={group.label}>
                            {(state.groupBy === "project" ? leaf(group.label) : group.label) ||
                              language.t("account.usage.unknown")}
                          </td>
                          <td class="usage-num usage-cost">
                            <span class="usage-share" style={{ width: `${shareOf(group.cost)}%` }} aria-hidden="true" />
                            <span class="usage-cost-value">{money(group.cost)}</span>
                          </td>
                          <td class="usage-num">{compact.format(tokensOf(group))}</td>
                          <td class="usage-num">{compact.format(group.calls)}</td>
                        </tr>
                      )}
                    </For>
                  </tbody>
                </table>
              </div>
              <Pager
                page={state.groupPage}
                size={SIZE.groups}
                total={groups().length}
                onPage={(next) => setState("groupPage", next)}
              />
              <p class="usage-note">{language.t("account.usage.note")}</p>
            </section>
          </div>
        </Show>

        <Show when={props.platform}>
          <section class="usage-section">
            <h3>{language.t("account.usage.organizations")}</h3>
            <div class="usage-table-scroll" data-scrollable>
              <table class="usage-table">
                <thead>
                  <tr>
                    <th scope="col">{language.t("account.usage.organization")}</th>
                    <th scope="col" class="usage-num">{language.t("account.usage.cost")}</th>
                    <th scope="col" class="usage-num">{language.t("account.usage.tokens")}</th>
                    <th scope="col" class="usage-num">{language.t("account.usage.calls")}</th>
                    <th scope="col" class="usage-num">{language.t("account.usage.users")}</th>
                  </tr>
                </thead>
                <tbody>
                  <For each={page(state.organizations, state.organizationPage, SIZE.organizations)}>
                    {(item) => (
                      <tr>
                        <td class="usage-col-title">{item.name}</td>
                        <td class="usage-num">{money(item.cost)}</td>
                        <td class="usage-num">{compact.format(tokensOf(item))}</td>
                        <td class="usage-num">{compact.format(item.calls)}</td>
                        <td class="usage-num">{compact.format(item.users)}</td>
                      </tr>
                    )}
                  </For>
                </tbody>
              </table>
            </div>
            <Pager
              page={state.organizationPage}
              size={SIZE.organizations}
              total={state.organizations.length}
              onPage={(next) => setState("organizationPage", next)}
            />
          </section>
        </Show>

        <Show when={!props.platform && state.tab === "sessions"}>
          <section class="usage-section">
            <Show
              when={state.open}
              fallback={
                <>
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
                      <Show when={!state.sessionsLoading} fallback={<Loader />}>
                        <p class="usage-empty">{language.t("account.usage.sessionsEmpty")}</p>
                      </Show>
                    }
                  >
                    <div class="usage-table-scroll" data-scrollable data-busy={state.sessionsLoading}>
                      <table class="usage-table" data-rows="interactive">
                        <thead>
                          <tr>
                            <th scope="col">{language.t("account.usage.session")}</th>
                            <th scope="col" class="usage-secondary">{language.t("account.usage.holder")}</th>
                            <th scope="col" class="usage-secondary">{language.t("account.usage.group.project")}</th>
                            <th scope="col" class="usage-num">{language.t("account.usage.cost")}</th>
                            <th scope="col" class="usage-num">{language.t("account.usage.tokens")}</th>
                            <th scope="col" class="usage-secondary">{language.t("account.usage.updated")}</th>
                          </tr>
                        </thead>
                        <tbody>
                          <For each={state.sessions}>
                            {(session) => (
                              <tr
                                tabIndex={0}
                                onClick={() => open(session)}
                                onKeyDown={(event) => (event.key === "Enter" || event.key === " ") && open(session)}
                              >
                                <td class="usage-col-title" title={session.title || session.id}>
                                  {session.title || session.id}
                                </td>
                                <td class="usage-secondary">{session.holder ?? "—"}</td>
                                <td class="usage-secondary usage-col-project" title={session.project ?? ""}>
                                  {session.project ? leaf(session.project) : "—"}
                                </td>
                                <td class="usage-num">{money(session.cost)}</td>
                                <td class="usage-num">{compact.format(session.tokens)}</td>
                                <td class="usage-secondary">{when.format(new Date(session.updated))}</td>
                              </tr>
                            )}
                          </For>
                        </tbody>
                      </table>
                    </div>
                    <Pager
                      page={state.sessionPage}
                      size={SIZE.sessions}
                      total={state.sessionsTotal}
                      onPage={(next) => void loadSessions(next)}
                    />
                  </Show>
                </>
              }
            >
              {(session) => (
                <>
                  <div class="usage-section-head">
                    <Button
                      type="button"
                      variant="ghost"
                      icon="chevron-left"
                      onClick={() => setState({ open: undefined, messages: [] })}
                    >
                      {language.t("account.usage.back")}
                    </Button>
                    <div class="usage-detail-meta">
                      <strong title={session().title || session().id}>{session().title || session().id}</strong>
                      <span>
                        {[session().holder, session().project ? leaf(session().project) : undefined, money(session().cost)]
                          .filter(Boolean)
                          .join(" · ")}
                      </span>
                    </div>
                  </div>
                  <Show when={!state.messagesLoading} fallback={<Loader />}>
                    <ol class="usage-messages" aria-label={language.t("account.usage.messages")}>
                      <For each={state.messages}>
                        {(message) => (
                          <li data-type={message.type}>
                            <div class="usage-message-meta">
                              <span>{message.type}</span>
                              <span>{message.user ?? ""}</span>
                              <span>{when.format(new Date(message.created))}</span>
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
                  <Pager
                    page={state.messagePage}
                    size={SIZE.messages}
                    hasNext={state.messagesMore}
                    onPage={(next) => void loadMessages(session(), next)}
                  />
                </>
              )}
            </Show>
          </section>
        </Show>
      </Show>
    </section>
  )
}

/** A member's own usage in the organization they are in, from the account menu. */
export function UsageDialog(props: { server: ServerConnection.Http; organizationID: string; admin: boolean }) {
  const language = useLanguage()
  return (
    <Dialog size="x-large" fit>
      <DialogHeader>
        <DialogTitleGroup
          title={language.t(props.admin ? "account.usage.title" : "account.usage.navOwn")}
          description=""
        />
      </DialogHeader>
      <DialogBody class="flex flex-col gap-4 px-4 pb-4" data-scrollable>
        <UsagePanel
          server={props.server}
          organizationID={props.organizationID}
          description={language.t(props.admin ? "account.usage.description" : "account.usage.descriptionOwn")}
        />
      </DialogBody>
    </Dialog>
  )
}
