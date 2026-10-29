import { createEffect, createResource, createSignal, For, onCleanup, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { Icon } from "@opencode/ui/icon"
import { Tooltip } from "@opencode/ui/tooltip"
import { useLanguage } from "@/runtime/i18n/language"
import { showToast } from "@/shell/notifications/toast"
import { accountFetch, type AccountAccessInfo } from "./api"
import { useAccountOptional } from "./gate"

type Kind = "session" | "project"

// IDs are unique across both kinds, so one store serves the whole app and rows share what any of them fetched.
const [infos, setInfos] = createStore<Record<string, AccountAccessInfo | null>>({})
const queued: Record<Kind, Set<string>> = { session: new Set(), project: new Set() }
let timer: ReturnType<typeof setTimeout> | undefined

/**
 * Owners and visibility of sessions and projects, fetched in batches as rows ask for them. Only an organization
 * member gets answers; without an account (a server with no sign-in) nothing is shown and nothing is requested.
 */
export function useAccessInfo() {
  const account = useAccountOptional()
  const language = useLanguage()

  const flush = () => {
    timer = undefined
    if (!account) return
    for (const kind of ["session", "project"] as const) {
      const ids = [...queued[kind]]
      queued[kind].clear()
      if (ids.length === 0) continue
      void accountFetch<Record<string, AccountAccessInfo>>({
        url: account.server.http.url,
        password: account.server.http.password,
        path: kind === "session" ? "/api/session-access" : "/api/project-access",
        body: kind === "session" ? { sessionIDs: ids } : { projectIDs: ids },
      })
        .then((found) => setInfos(Object.fromEntries(ids.map((id) => [id, found[id] ?? null]))))
        .catch(() => undefined)
    }
  }

  const info = (kind: Kind, id: string | undefined) => {
    if (!account || !id) return undefined
    if (!(id in infos)) {
      queued[kind].add(id)
      timer ??= setTimeout(flush, 30)
    }
    return infos[id] ?? undefined
  }

  const setVisibility = async (kind: Kind, id: string | undefined, visibility: AccountAccessInfo["visibility"]) => {
    if (!account || !id) return
    try {
      await accountFetch({
        url: account.server.http.url,
        password: account.server.http.password,
        path: `/api/${kind}/${id}/visibility`,
        method: "PUT",
        body: { visibility },
      })
      const current = infos[id]
      if (current) setInfos(id, { ...current, visibility })
    } catch {
      showToast({ variant: "error", title: language.t("account.access.failed") })
    }
  }

  return { info, setVisibility }
}

/** Who created a session or project and who can see it, for its menu. Nothing when it isn't known. */
export function accessSummary(language: ReturnType<typeof useLanguage>, info: AccountAccessInfo | undefined) {
  if (!info) return undefined
  const visibility = language.t(info.visibility === "private" ? "account.access.statusPrivate" : "account.access.statusShared")
  return info.owner ? `${language.t("account.access.owner", { employeeID: info.owner })} · ${visibility}` : visibility
}

/** The menu label that flips a session or project between private and visible to the organization. */
export function visibilityLabel(language: ReturnType<typeof useLanguage>, visibility: AccountAccessInfo["visibility"]) {
  return language.t(visibility === "private" ? "account.access.makeShared" : "account.access.makePrivate")
}

const HEARTBEAT = 20_000
const POLL = 10_000

/** Tells the server this session is open and shows who else has it open right now. */
export function SessionViewers(props: { sessionID: string }) {
  const account = useAccountOptional()
  const language = useLanguage()
  // Who is here is first asked once this session has announced itself, so opening it costs one read, not two.
  const [announced, setAnnounced] = createSignal(false)
  const [viewers, { refetch }] = createResource(
    () => (account && announced() ? props.sessionID : undefined),
    (sessionID) =>
      accountFetch<string[]>({
        url: account!.server.http.url,
        password: account!.server.http.password,
        path: `/api/session/${sessionID}/presence`,
      }).catch(() => [] as string[]),
    { initialValue: [] },
  )

  createEffect(() => {
    const sessionID = props.sessionID
    if (!account) return
    setAnnounced(false)
    const beat = () => {
      if (document.visibilityState !== "visible") return
      void accountFetch({
        url: account.server.http.url,
        password: account.server.http.password,
        path: `/api/session/${sessionID}/presence`,
        method: "PUT",
      })
        .then(() => (announced() ? refetch() : setAnnounced(true)))
        .catch(() => undefined)
    }
    beat()
    const heartbeat = setInterval(beat, HEARTBEAT)
    const poll = setInterval(() => void refetch(), POLL)
    onCleanup(() => {
      clearInterval(heartbeat)
      clearInterval(poll)
    })
  })

  const others = () => (viewers.latest ?? []).filter((employeeID) => employeeID !== account?.session.employeeID)

  return (
    <Show when={others().length > 0}>
      <Tooltip
        class="flex shrink-0 items-center"
        placement="bottom"
        value={language.t("account.access.viewing", { employeeIDs: others().join(", ") })}
      >
        <div data-component="session-viewers" class="flex items-center gap-1">
          <Icon name="outline-eye" size="small" class="shrink-0 text-v2-icon-icon-muted" />
          <For each={others().slice(0, 3)}>
            {(employeeID) => (
              <span class="rounded-full border border-v2-border-border-base px-2 text-11-regular text-v2-text-text-muted">
                {employeeID}
              </span>
            )}
          </For>
          <Show when={others().length > 3}>
            <span class="text-11-regular text-v2-text-text-muted">+{others().length - 3}</span>
          </Show>
        </div>
      </Tooltip>
    </Show>
  )
}
