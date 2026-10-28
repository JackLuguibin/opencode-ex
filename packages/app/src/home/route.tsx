import { Icon } from "@opencode/ui/icon"
import { displayName } from "@opencode/ui/project-avatar"
import { Show } from "solid-js"
import { createMediaQuery } from "@solid-primitives/media"
import { useSettings } from "@/settings/model"
import { HomeNavigation } from "./navigation"
import { createStore } from "solid-js/store"
import { useLanguage } from "@/runtime/i18n/language"
import { createHomeController } from "./model"
import { createHomeProjectsController } from "./projects/controller"
import { HomeWelcome } from "./welcome"
import { SharedSpace } from "./shared/view"
import "./home.css"

export function Home() {
  const language = useLanguage()
  const home = createHomeController()
  const projects = createHomeProjectsController(home)
  const settings = useSettings()
  const mobile = createMediaQuery("(max-width: 767px)")
  const [state, setState] = createStore({ prompt: "", opening: false })

  const projectName = () => {
    const project = home.project.newSession()

    return project && displayName(project)
  }

  // The organization's shared space is a place to browse files, not to start a session in.
  const sharedDirectory = () => {
    return projects.shared.selected() ? home.selection.value().directory : undefined
  }

  const prompt = () => state.prompt.trim()

  const start = async () => {
    const text = prompt()

    if (!home.project.newSession() || state.opening || !text) return
    setState("opening", true)
    await home.project.openPrompt(text)
    setState("opening", false)
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
              <form
                class="home-start"
                onSubmit={(event) => {
                  event.preventDefault()
                  void start()
                }}
              >
                <button
                  type="button"
                  class="home-context"
                  onClick={() => {
                    const server = home.server.focused()

                    if (server) projects.project.choose(server)
                  }}
                >
                  <Icon name="folder" size="small" />
                  <span class="truncate">{projectName() ?? language.t("home.project.add")}</span>
                  <Icon name="chevron-down" size="small" />
                </button>
                <div class="home-start-input">
                  <textarea
                    aria-label={language.t("home.prompt")}
                    placeholder={language.t("home.prompt")}
                    value={state.prompt}
                    onInput={(event) => setState("prompt", event.currentTarget.value)}
                    onKeyDown={(event) => {
                      if (event.key !== "Enter" || event.shiftKey || event.isComposing) return
                      event.preventDefault()
                      void start()
                    }}
                  />
                  <div class="home-start-actions">
                    <span>{language.t("home.startHint")}</span>
                    <button type="submit" disabled={!home.project.newSession() || state.opening || !prompt()}>
                      {language.t("common.continue")}
                      <Icon name="arrow-right" size="small" />
                    </button>
                  </div>
                </div>
              </form>
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
