import type { SessionInfo } from "@opencode/client/promise"
import { Icon } from "@opencode/ui/icon"
import { Loader } from "@opencode/ui/loader"
import { useQuery } from "@tanstack/solid-query"
import { useNavigate } from "@solidjs/router"
import { createMemo, For, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { getFilename } from "@opencode/util/path"
import { homeSessionsQuery } from "@/home/sessions/queries"
import { createHomeController } from "@/home/model"
import { useAccessInfo } from "@/identity/access"
import { useAccountOptional } from "@/identity/gate"
import { useLanguage } from "@/runtime/i18n/language"
import { ServerConnection } from "@/runtime/server/registry"
import { compareSessionTime } from "@/shell/layout/helpers"
import { sessionHref } from "@/shell/routes/session"
import { useSessionTabAvatarState } from "@/shell/layout/project-avatar-state"
import { SessionProgressIndicatorV2 } from "@opencode/session-ui/v2/session-progress-indicator-v2"
import { sessionLabel } from "@/session/title"

type Node = { session: SessionInfo; children: Node[] }

/** The sessions the signed-in member created, newest first. */
export function PersonalSessionsPage() {
  const language = useLanguage()
  const home = createHomeController()
  const account = useAccountOptional()
  const access = useAccessInfo()
  const navigate = useNavigate()

  const query = useQuery(() => homeSessionsQuery(home.server.focused(), home.server.focusedContext()))
  const mine = createMemo(() =>
    (query.data?.() ?? [])
      .filter((session) => access.info("session", session.id)?.owner === account?.session.employeeID)
      .toSorted(compareSessionTime),
  )

  const [collapsed, setCollapsed] = createStore<Record<string, boolean>>({})

  // Sessions group under their project; a session whose parent is also listed hangs off that parent.
  const tree = createMemo(() => {
    const ids = new Set(mine().map((session) => session.id))
    const children = Map.groupBy(
      mine().filter((session) => session.parentID && ids.has(session.parentID)),
      (session) => session.parentID!,
    )
    const build = (session: SessionInfo): Node => ({ session, children: (children.get(session.id) ?? []).map(build) })
    const roots = mine().filter((session) => !session.parentID || !ids.has(session.parentID))
    return [...Map.groupBy(roots, (session) => session.projectID)].map(([id, sessions]) => ({
      id,
      name: getFilename(sessions[0].location.directory) || sessions[0].location.directory,
      count: sessions.length + sessions.flatMap((session) => children.get(session.id) ?? []).length,
      nodes: sessions.map(build),
    }))
  })

  const SessionNode = (props: { node: Node; depth: number }) => {
    const status = useSessionTabAvatarState(
      () => ServerConnection.key(home.server.focused()!),
      () => props.node.session.id,
      () => true,
      () => props.node.session,
    )
    return (
    <li>
      <button
        type="button"
        data-action="personal-session-open"
        class="flex h-8 w-full min-w-0 items-center gap-2 px-2 text-start text-[13px] text-v2-text-text-base hover:bg-v2-overlay-simple-overlay-hover"
        onClick={() => {
          const conn = home.server.focused()
          if (conn) navigate(sessionHref(ServerConnection.key(conn), props.node.session.id))
        }}
      >
        <span
          data-slot="personal-session-status"
          data-state={status.loading() ? "running" : status.unread() ? "done" : undefined}
          class="flex size-4 shrink-0 items-center justify-center"
          role="img"
          aria-label={
            status.loading()
              ? language.t("home.session.status.running")
              : status.unread()
                ? language.t("home.session.status.done")
                : undefined
          }
        >
          <Show when={!status.loading()} fallback={<SessionProgressIndicatorV2 />}>
            <Show when={status.unread()}>
              <span class="size-1.5 rounded-full bg-v2-text-text-base" />
            </Show>
          </Show>
        </span>
        <span class="min-w-0 flex-1 truncate">{sessionLabel(props.node.session)}</span>
        <Show when={access.info("session", props.node.session.id)?.visibility === "private"}>
          <Icon name="lock" size="small" class="shrink-0 text-v2-icon-icon-muted" />
        </Show>
        <span class="shrink-0 tabular-nums text-v2-text-text-muted">{time(props.node.session)}</span>
      </button>
      <Show when={props.node.children.length > 0}>
        <ul class="ms-3.5 border-s border-v2-border-border-muted ps-1">
          <For each={props.node.children}>{(child) => <SessionNode node={child} depth={props.depth + 1} />}</For>
        </ul>
      </Show>
    </li>
    )
  }

  const time = (session: SessionInfo) =>
    new Intl.DateTimeFormat(language.locale(), { dateStyle: "short", timeStyle: "short" }).format(
      session.time.updated ?? session.time.created,
    )

  return (
    <div
      data-slot="personal-sessions-page"
      class="flex min-h-0 flex-1 flex-col border-s-[1.5px] border-v2-border-border-strong bg-v2-background-bg-base"
    >
      <header class="flex h-12 shrink-0 items-center border-b-[1.5px] border-v2-border-border-strong px-6">
        <h1 class="text-[15px] font-[530] leading-[var(--line-height-base)] text-v2-text-text-strong">
          {language.t("personal.page.title")}
        </h1>
      </header>
      <div data-scrollable class="flex min-h-0 flex-1 flex-col overflow-y-auto px-6 py-5">
        <Show
          when={!query.isPending}
          fallback={
            <div class="flex justify-center py-10">
              <Loader />
            </div>
          }
        >
          <Show
            when={mine().length > 0}
            fallback={<p class="py-10 text-center text-[13px] text-v2-text-text-muted">{language.t("personal.page.empty")}</p>}
          >
            <div class="flex flex-col gap-3">
              <For each={tree()}>
                {(group) => (
                  <section data-slot="personal-project" class="flex flex-col border-[1.5px] border-v2-border-border-strong p-1">
                    <button
                      type="button"
                      data-action="personal-project-toggle"
                      aria-expanded={!collapsed[group.id]}
                      class="flex h-8 w-full items-center gap-1.5 px-2 text-start text-[12px] font-[530] text-v2-text-text-strong hover:bg-v2-overlay-simple-overlay-hover"
                      onClick={() => setCollapsed(group.id, !collapsed[group.id])}
                    >
                      <Icon
                        name="chevron-down"
                        size="small"
                        class="shrink-0 text-v2-icon-icon-muted transition-transform"
                        classList={{ "-rotate-90": collapsed[group.id] }}
                      />
                      <Icon name="folder" size="small" class="shrink-0 text-v2-icon-icon-muted" />
                      <span class="min-w-0 flex-1 truncate">{group.name}</span>
                      <span class="shrink-0 tabular-nums font-normal text-v2-text-text-muted">{group.count}</span>
                    </button>
                    <Show when={!collapsed[group.id]}>
                      <ul class="ms-3.5 border-s border-v2-border-border-muted ps-1">
                        <For each={group.nodes}>{(node) => <SessionNode node={node} depth={0} />}</For>
                      </ul>
                    </Show>
                  </section>
                )}
              </For>
            </div>
          </Show>
        </Show>
      </div>
    </div>
  )
}
