import { For, Show } from "solid-js"
import { Icon } from "@opencode/ui/icon"
import { IconButton } from "@opencode/ui/icon-button"
import { Loader } from "@opencode/ui/loader"
import { Menu } from "@opencode/ui/menu"
import { Tooltip } from "@opencode/ui/tooltip"
import { useLayout } from "@/shell/state/layout"
import { sessionLabel } from "@/session/title"
import { accessSummary, useAccessInfo, visibilityLabel } from "@/identity/access"
import { type HomeSessionsController } from "./sessions/controller"
import { useLanguage } from "@/runtime/i18n/language"
import { createHomeController, type HomeController } from "./model"
import { createHomeProjectsController } from "./projects/controller"
import { HomeUtilityNav } from "./projects/view"
import { HomeProjects } from "./projects/region"
import { createHomeScrollController } from "./scroll"
import { createHomeSessionsController } from "./sessions/controller"
import "./home.css"

export function HomeNavigation(props: { home?: HomeController; embedded?: boolean }) {
  const language = useLanguage()
  const home = props.home ?? createHomeController()
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
      <div class="home-project-list">
        <HomeProjects
          projects={projects}
          scroll={scroll}
          renderSessions={() => <ProjectSessions sessions={sessions} />}
        />
      </div>
      <HomeUtilityNav
        class="flex shrink-0 pt-2"
        onOpenSettings={projects.utility.settings}
        language={projects.copy.language}
      />
    </aside>
  )
}

function ProjectSessions(props: { sessions: HomeSessionsController }) {
  const language = useLanguage()
  const access = useAccessInfo()
  const layout = useLayout()

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
          each={props.sessions.data.records()}
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

            return (
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
                >
                  <span data-slot="home-project-session-label" class="min-w-0 flex-1 truncate">
                    {label}
                  </span>
                </button>
                <div
                  data-slot="home-row-actions"
                  class="hover-reveal absolute inset-y-0 end-1 flex items-center rounded-e-[6px] ps-2 group-hover/session:opacity-100 focus-within:opacity-100"
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
            )
          }}
        </For>
      </Show>
    </ul>
  )
}
