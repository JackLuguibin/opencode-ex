import { Icon } from "@opencode/ui/icon"
import { displayName } from "@opencode/ui/project-avatar"
import { Show } from "solid-js"
import { createMediaQuery } from "@solid-primitives/media"
import { useSettings } from "@/settings/model"
import { HomeNavigation } from "./navigation"
import { useLanguage } from "@/runtime/i18n/language"
import { createHomeController } from "./model"
import { createHomeProjectsController } from "./projects/controller"
import { HomeComposer } from "./composer"
import { HomeWelcome } from "./welcome"
import { SharedSpace } from "./shared/view"
import "./home.css"

export function Home() {
  const language = useLanguage()
  const home = createHomeController()
  const projects = createHomeProjectsController(home)
  const settings = useSettings()
  const mobile = createMediaQuery("(max-width: 767px)")

  const projectName = () => {
    const project = home.project.newSession()

    return project && displayName(project)
  }

  // The organization's shared space is a place to browse files, not to start a session in.
  const sharedDirectory = () => {
    return projects.shared.selected() ? home.selection.value().directory : undefined
  }

  const chooseProject = () => {
    const server = home.server.focused()

    if (server) projects.project.choose(server)
  }

  return (
    <div data-slot="home-panel" class="home-layout" data-scrollable>
      <Show when={mobile() || settings.appearance.tabLayout() === "horizontal"}>
        <HomeNavigation home={home} />
      </Show>
      <section class="home-workspace" aria-label={language.t("command.session.new")}>
        <Show
          when={sharedDirectory()}
          fallback={
            <>
              <HomeWelcome project={projectName()} />
              <div class="home-start">
                <Show
                  when={home.project.newSession()?.worktree}
                  fallback={
                    <button type="button" class="home-context" onClick={chooseProject}>
                      <Icon name="folder" size="small" />
                      <span class="truncate">{language.t("home.project.add")}</span>
                      <Icon name="chevron-down" size="small" />
                    </button>
                  }
                >
                  {(directory) => (
                    <Show when={home.server.focused()}>
                      {(conn) => (
                        <HomeComposer conn={conn()} directory={directory()}>
                          <button type="button" class="home-context" onClick={chooseProject}>
                            <Icon name="folder" size="small" />
                            <span class="truncate">{projectName()}</span>
                            <Icon name="chevron-down" size="small" />
                          </button>
                        </HomeComposer>
                      )}
                    </Show>
                  )}
                </Show>
              </div>
            </>
          }
        >
          {(directory) => (
            <Show when={home.server.focusedContext()}>
              {(ctx) => <SharedSpace ctx={ctx()} directory={directory()} />}
            </Show>
          )}
        </Show>
      </section>
    </div>
  )
}
