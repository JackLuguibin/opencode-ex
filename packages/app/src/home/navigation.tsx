import { useNavigate } from "@solidjs/router"
import type { SessionInfo } from "@opencode/client/promise"
import { createSignal, For, Show } from "solid-js"
import { Icon } from "@opencode/ui/icon"
import { IconButton } from "@opencode/ui/icon-button"
import { Loader } from "@opencode/ui/loader"
import { Menu } from "@opencode/ui/menu"
import { Tooltip } from "@opencode/ui/tooltip"
import { ClockGlyph } from "@/session/composer/schedule-row"
import { useLayout } from "@/shell/state/layout"
import { sessionLabel } from "@/session/title"
import { useAccountOptional } from "@/identity/gate"
import { accessSummary, useAccessInfo, visibilityLabel } from "@/identity/access"
import { HomeSessionStatusController, type HomeSessionRecord, type HomeSessionsController } from "./sessions/controller"
import { SessionProgressIndicatorV2 } from "@opencode/session-ui/v2/session-progress-indicator-v2"
import { useLanguage } from "@/runtime/i18n/language"
import { createHomeController, type HomeController } from "./model"
import { createHomeProjectsController } from "./projects/controller"
import { HomeUtilityNav } from "./projects/view"
import { HomeProjects } from "./projects/region"
import { createHomeScrollController } from "./scroll"
import { createHomeSessionsController } from "./sessions/controller"
import "./home.css"

const MINE_KEY = "opencode.sidebar.only-mine"

const [onlyMine, setOnlyMine] = createSignal(
  (() => {
    try {
      return localStorage.getItem(MINE_KEY) === "1"
    } catch {
      return false
    }
  })(),
)

function toggleOnlyMine() {
  const next = !onlyMine()
  setOnlyMine(next)
  try {
    localStorage.setItem(MINE_KEY, next ? "1" : "0")
  } catch {}
}

export function HomeNavigation(props: { home?: HomeController; embedded?: boolean }) {
  const language = useLanguage()
  const home = props.home ?? createHomeController()
  const layout = useLayout()
  const navigate = useNavigate()
  const account = useAccountOptional()
  const projects = createHomeProjectsController(home)
  const sessions = createHomeSessionsController(home)
  const scroll = createHomeScrollController(sessions.data.groups)
  const projectOpen = () => !!home.selection.value().directory

  return (
    <aside
      class="home-navigation"
      classList={{ "home-navigation-embedded": props.embedded }}
      data-project-open={projectOpen() ? "" : undefined}
      aria-label={language.t("home.title")}
    >
      <Show when={!props.embedded}>
        <button
          type="button"
          class="home-new-chat"
          disabled={!sessions.session.canCreate()}
          onClick={() => home.project.openNewSession()}
        >
          <Icon name="edit" size="small" />
          {language.t("command.session.new")}
        </button>
      </Show>
      <Show when={projects.shared.directory()}>
        <button
          type="button"
          class="home-new-chat"
          data-action="home-shared-space"
          aria-current={projects.shared.selected() ? "page" : undefined}
          data-selected={projects.shared.selected() ? "" : undefined}
          onClick={projects.shared.open}
        >
          <Icon name="folder" size="small" />
          {language.t("home.shared.title")}
        </button>
      </Show>
      <button
        type="button"
        class="home-new-chat"
        data-action="home-schedule"
        aria-current={layout.route().type === "schedule" ? "page" : undefined}
        data-selected={layout.route().type === "schedule" ? "" : undefined}
        onClick={() => navigate("/schedule")}
      >
        <ClockGlyph size={16} />
        {language.t("sidebar.schedule")}
      </button>
      <button
        type="button"
        class="home-new-chat"
        data-action="home-queue"
        aria-current={layout.route().type === "queue" ? "page" : undefined}
        data-selected={layout.route().type === "queue" ? "" : undefined}
        onClick={() => navigate("/queue")}
      >
        <Icon name="circle-check" size="small" />
        {language.t("sidebar.queue")}
      </button>
      <Show when={account}>
        <button
          type="button"
          class="home-new-chat"
          data-action="home-personal"
          aria-current={layout.route().type === "personal" ? "page" : undefined}
          data-selected={layout.route().type === "personal" ? "" : undefined}
          onClick={() => navigate("/personal")}
        >
          <Icon name="comment" size="small" />
          {language.t("sidebar.personal")}
        </button>
      </Show>
      <div class="home-project-list">
        <HomeProjects
          projects={projects}
          scroll={scroll}
          headerActions={
            <Show when={account}>
              <Tooltip placement="bottom" value={language.t("sidebar.onlyMine")}>
                <IconButton
                  data-action="home-only-mine"
                  variant="ghost-muted"
                  size="large"
                  class="titlebar-icon [&_[data-slot=icon-svg]]:text-v2-icon-icon-muted"
                  data-selected={onlyMine() ? "" : undefined}
                  aria-pressed={onlyMine()}
                  icon={<Icon name={onlyMine() ? "circle-check" : "comment"} />}
                  onClick={toggleOnlyMine}
                  aria-label={language.t("sidebar.onlyMine")}
                />
              </Tooltip>
            </Show>
          }
          renderSessions={(worktree) => <ProjectSessions sessions={sessions} worktree={worktree} />}
        />
      </div>
      <HomeUtilityNav
        class="-ms-[18px] -me-[10px] mt-2 flex shrink-0 border-t border-v2-border-border-muted ps-[18px] pe-[10px] pt-2"
        onOpenSettings={projects.utility.settings}
        language={projects.copy.language}
      />
    </aside>
  )
}

// Far above any depth a research tree reaches; it only guards against a malformed parent cycle.
const MAX_CHILD_DEPTH = 16

function ChildToggle(props: { sessions: HomeSessionsController; id: string; count: number }) {
  const language = useLanguage()
  const open = () => !props.sessions.data.fold.has(props.id)

  return (
    <button
      type="button"
      data-action="home-session-children-toggle"
      class="absolute inset-y-0 end-1 z-10 flex items-center gap-0.5 rounded-[6px] px-1 text-v2-icon-icon-muted hover:text-v2-text-text-base"
      aria-expanded={open()}
      aria-label={language.t(open() ? "home.session.children.collapse" : "home.session.children.expand")}
      title={language.t(open() ? "home.session.children.collapse" : "home.session.children.expand")}
      onClick={(event) => {
        event.preventDefault()
        event.stopPropagation()
        props.sessions.data.fold.toggle(props.id)
      }}
    >
      <Show when={!open()}>
        <span class="text-[11px] leading-4">{props.count}</span>
      </Show>
      <Icon name={open() ? "chevron-down" : "chevron-right"} size="small" />
    </button>
  )
}
// Child sessions of one parent, each followed by its own children, so a research tree shows every level.
function ChildRows(props: {
  sessions: HomeSessionsController
  record: HomeSessionRecord
  kids: () => SessionInfo[]
  depth: number
}) {
  const language = useLanguage()
  const layout = useLayout()
  const kids = props.kids

  return (
    <For each={kids()}>
      {(child, index) => {
        const childActive = () => {
          const route = layout.route()

          return (
            route.type === "session" && route.server === props.sessions.session.server() && route.sessionId === child.id
          )
        }
        const childLabel = sessionLabel(child)
        const grandKids = props.sessions.data.children(() => child)

        return (
          <>
            <li
              class="home-project-session-row relative flex h-7 min-w-0 items-center rounded-[6px]"
              data-home-row
              data-child-session=""
              style={{ "--child-depth": props.depth }}
              data-last={index() === kids().length - 1 ? "" : undefined}
              data-selected={childActive() ? "" : undefined}
            >
              <button
                type="button"
                class="home-project-session"
                aria-current={childActive() ? "page" : undefined}
                title={childLabel}
                onClick={() => props.sessions.session.open(child)}
                onDblClick={() => grandKids().length > 0 && props.sessions.data.fold.toggle(child.id)}
              >
                <Show when={props.sessions.session.server()}>
                  {(server) => (
                    <HomeSessionStatusController
                      server={server()}
                      record={{ ...props.record, session: child }}
                      isOpenTab={props.sessions.tab.isOpen}
                      child
                      kids={grandKids}
                      render={(state) => (
                        <span
                          data-slot="home-session-status"
                          class="flex size-4 shrink-0 items-center justify-center"
                          role="img"
                          aria-label={
                            state.loading()
                              ? language.t("home.session.status.running")
                              : state.unread()
                                ? language.t("home.session.status.done")
                                : undefined
                          }
                        >
                          <Show when={!state.loading()} fallback={<SessionProgressIndicatorV2 />}>
                            <Show
                              when={state.unread()}
                              fallback={<Show
                                when={state.hiddenUnread() && props.sessions.data.fold.has(child.id)}
                                fallback={<Icon name="branch-out" size="small" class="text-v2-icon-icon-muted" />}
                              >
                                <span class="size-1.5 rounded-full border border-v2-text-text-base" />
                              </Show>}
                            >
                              <span class="size-1.5 rounded-full bg-v2-text-text-base" />
                            </Show>
                          </Show>
                        </span>
                      )}
                    />
                  )}
                </Show>
                <span data-slot="home-project-session-label" class="min-w-0 flex-1 truncate ps-1.5">
                  {childLabel}
                </span>
              </button>
              <Show when={props.depth < MAX_CHILD_DEPTH && grandKids().length > 0}>
                <ChildToggle sessions={props.sessions} id={child.id} count={grandKids().length} />
              </Show>
            </li>
            <Show when={props.depth < MAX_CHILD_DEPTH && !props.sessions.data.fold.has(child.id)}>
              <ChildRows
                sessions={props.sessions}
                record={props.record}
                kids={grandKids}
                depth={props.depth + 1}
              />
            </Show>
          </>
        )
      }}
    </For>
  )
}

function ProjectSessions(props: { sessions: HomeSessionsController; worktree: string }) {
  const records = props.sessions.data.projectRecords(props.worktree)
  const language = useLanguage()
  const access = useAccessInfo()
  const layout = useLayout()
  const account = useAccountOptional()

  // Ownership loads lazily per row, so a row stays hidden until it is known to be the member's own.
  const visible = () =>
    !account || !onlyMine()
      ? records()
      : records().filter((record) => access.info("session", record.session.id)?.owner === account.session.employeeID)

  return (
    <ul
      class="home-project-sessions"
      aria-label={language.t("home.sessions.search.sessions")}
      aria-busy={props.sessions.data.loading()}
    >
      <Show
        when={!props.sessions.data.loading()}
        fallback={
          <li class="flex justify-center py-3">
            <Loader />
          </li>
        }
      >
        <For
          each={visible()}
          fallback={<li class="px-2 py-2 text-v2-text-text-faint">{language.t("home.sessions.empty")}</li>}
        >
          {(record) => {
            const active = () => {
              const route = layout.route()

              return (
                route.type === "session" &&
                route.server === props.sessions.session.server() &&
                route.sessionId === record.session.id
              )
            }

            const label = sessionLabel(record.session)
            const kids = props.sessions.data.children(() => record.session)

            return (
              <>
                <li
                  class="home-project-session-row group/session relative flex h-7 min-w-0 items-center rounded-[6px]"
                  data-home-row
                  data-selected={active() ? "" : undefined}
                >
                  <button
                    type="button"
                    class="home-project-session"
                    aria-current={active() ? "page" : undefined}
                    title={label}
                    onClick={() => props.sessions.session.open(record.session)}
                    onDblClick={() => kids().length > 0 && props.sessions.data.fold.toggle(record.session.id)}
                  >
                    <Show when={props.sessions.session.server()}>
                      {(server) => (
                        <HomeSessionStatusController
                          server={server()}
                          record={record}
                          isOpenTab={props.sessions.tab.isOpen}
                          kids={kids}
                          render={(state) => (
                            <span
                              data-slot="home-session-status"
                              data-state={state.loading() ? "running" : state.unread() ? "done" : undefined}
                              class="flex size-4 shrink-0 items-center justify-center"
                              role="img"
                              aria-label={
                                state.loading()
                                  ? language.t("home.session.status.running")
                                  : state.unread()
                                    ? language.t("home.session.status.done")
                                    : undefined
                              }
                            >
                              <Show when={!state.loading()} fallback={<SessionProgressIndicatorV2 />}>
                                <Show
                                  when={state.unread()}
                                  fallback={<Show
                                  when={state.hiddenUnread() && props.sessions.data.fold.has(record.session.id)}
                                  fallback={<Icon name="speech-bubble" size="small" class="text-v2-icon-icon-muted" />}
                                >
                                  <span class="size-1.5 rounded-full border border-v2-text-text-base" />
                                </Show>}
                                >
                                  <span class="size-1.5 rounded-full bg-v2-text-text-base" />
                                </Show>
                              </Show>
                            </span>
                          )}
                        />
                      )}
                    </Show>
                    <span data-slot="home-project-session-label" class="min-w-0 flex-1 truncate ps-1.5">
                      {label}
                    </span>
                    <Show when={access.info("session", record.session.id)?.visibility === "private"}>
                      <Icon
                        name="lock"
                        size="small"
                        class="ms-1 shrink-0 text-v2-icon-icon-muted"
                        aria-label={language.t("account.access.statusPrivate")}
                      />
                    </Show>
                  </button>
                  <Show when={kids().length > 0}>
                    <ChildToggle sessions={props.sessions} id={record.session.id} count={kids().length} />
                  </Show>
                  <div
                    data-slot="home-row-actions"
                    class="hover-reveal absolute inset-y-0 end-6 flex items-center rounded-e-[6px] ps-2 group-hover/session:opacity-100 focus-within:opacity-100"
                  >
                    <Show when={accessSummary(language, access.info("session", record.session.id))}>
                      {(summary) => (
                        <Menu gutter={6} modal={false} placement="bottom-end">
                          <Menu.Trigger
                            as={IconButton}
                            data-action="home-project-session-menu"
                            variant="ghost-muted"
                            size="small"
                            icon={<Icon name="outline-dots" />}
                            aria-label={language.t("common.moreOptions")}
                            onClick={(event: MouseEvent) => event.stopPropagation()}
                          />
                          <Menu.Portal>
                            <Menu.Content>
                              <Menu.Item disabled>{summary()}</Menu.Item>
                              <Show when={access.info("session", record.session.id)?.canManage}>
                                <Menu.Item
                                  onSelect={() =>
                                    void access.setVisibility(
                                      "session",
                                      record.session.id,
                                      access.info("session", record.session.id)?.visibility === "private"
                                        ? "organization"
                                        : "private",
                                    )
                                  }
                                >
                                  {visibilityLabel(
                                    language,
                                    access.info("session", record.session.id)?.visibility ?? "organization",
                                  )}
                                </Menu.Item>
                              </Show>
                            </Menu.Content>
                          </Menu.Portal>
                        </Menu>
                      )}
                    </Show>
                    <Show when={access.info("session", record.session.id)?.canManage !== false}>
                      <Tooltip placement="bottom" value={language.t("common.delete")}>
                        <IconButton
                          data-action="home-project-session-delete"
                          variant="ghost-muted"
                          size="small"
                          icon={<Icon name="trash" />}
                          aria-label={language.t("common.delete")}
                          onClick={(event) => {
                            event.preventDefault()
                            event.stopPropagation()
                            const server = props.sessions.session.server()
                            if (!server) return
                            props.sessions.session.showDelete(server, record.session)
                          }}
                        />
                      </Tooltip>
                    </Show>
                  </div>
                </li>
                <Show when={!props.sessions.data.fold.has(record.session.id)}>
                  <ChildRows sessions={props.sessions} record={record} kids={kids} depth={1} />
                </Show>
              </>
            )
          }}
        </For>
      </Show>
    </ul>
  )
}
