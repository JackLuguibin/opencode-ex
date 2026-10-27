import { createPromptProjectController } from "@/new-session/project/selector"
import { useNewSessionLocationDialog } from "@/new-session/location/dialog"
import { tabKey, useTabs, type DraftTab } from "@/shell/tabs/tabs"
import { useLayout } from "@/shell/state/layout"
import { useSearchParams } from "@solidjs/router"
import { Show, createEffect, createMemo, createResource, on, onCleanup, untrack } from "solid-js"
import { createMediaQuery } from "@solid-primitives/media"
import { useServer } from "@/runtime/server/current"
import { createComposerModel } from "@/composer/model"
import { useComposerCommands } from "@/composer/commands"
import { useCommand } from "@/shell/commands/command"
import { useLanguage } from "@/runtime/i18n/language"
import { useWorkspaceLocation } from "@/workspaces/location"
import { createSizing } from "@/session/helpers"
import { useSessionLayout } from "@/session/session-layout"
import { SessionHeaderActions } from "@/session/header/session-header-actions"
import { createMountedSession } from "@/runtime/plugin/mounted-session"
import { PluginLinks } from "@/runtime/plugin/render"
import { createPanelSidebar, createRegion } from "@/runtime/plugin/panels"
import { SideRegion } from "@/runtime/plugin/side-region"
import { createPaneDrag } from "@/runtime/plugin/pane-drag"
import { usePluginAttachment } from "@/runtime/plugin/host-apis"
import { createNewSessionComposerAdapter } from "./composer-adapter"
import { NewSessionView } from "./view"
import { createNewSessionWorkspaceController } from "./workspace/controller"
import { useNewSessionCommands } from "./commands"
import { createDraftMcpControls } from "./mcp"

/** The draft-only Session page. Submitting promotes the draft into a real Session. */
export default function NewSessionPage(props: { draftId: string }) {
  const [search, setSearch] = useSearchParams<{ draftId?: string; prompt?: string; send?: string }>()
  const tabs = useTabs()
  const layout = useLayout()
  const server = useServer()
  let sent = false

  const draftTab = createMemo(() =>
    tabs.store.find((tab): tab is DraftTab => tab.type === "draft" && tab.draftID === search.draftId),
  )

  const workspace = createNewSessionWorkspaceController({
    selectedWorktree: () => draftTab()?.worktree,
    selectedBranch: () => draftTab()?.branch,
    setSelectedWorktree: (worktree) => {
      if (search.draftId) tabs.updateDraft(search.draftId, { worktree })
    },
    setSelectedBranch: (branch) => {
      if (search.draftId) tabs.updateDraft(search.draftId, { branch })
    },
  })

  const mcp = createDraftMcpControls({ draftID: props.draftId, worktree: workspace.selection.value })

  const composer = createNewSessionComposerAdapter({
    draftID: props.draftId,
    worktree: workspace.selection.value,
    branch: workspace.bar.branch,
    submitted: workspace.selection.remember,
    mcp,
  })

  const model = createComposerModel(composer.adapter)
  useComposerCommands({ model: composer.model })

  const project = createPromptProjectController({ controls: composer.project })
  const location = useNewSessionLocationDialog({ project, workspace, onDone: model.restoreFocus })
  const command = useCommand()
  const language = useLanguage()
  const desktop = createMediaQuery("(min-width: 768px)")
  const sessionLayout = useSessionLayout()
  const place = useWorkspaceLocation()
  const attachment = usePluginAttachment()
  const size = createSizing()
  const side = {
    opened: () => tabs.region(draftTab(), "side"),
    toggle: () => {
      const tab = draftTab()

      if (tab) tabs.setRegion(tab, "side", !tabs.region(tab, "side"))
    },
  }
  const directory = () => place().directory
  const mounted = createMountedSession({
    data: { isChild: () => false },
    identity: { sessionID: () => undefined },
    workspace: {
      directory,
      location: () => ({ directory: directory() }),
    },
    layout: {
      tabKey: () => {
        const tab = draftTab()

        return tab ? tabKey(tab) : undefined
      },
    },
  })
  const sidebar = createPanelSidebar()
  const region = createRegion({
    region: "side",
    view: mounted.view,
    screen: mounted.screen,
    tabs: sessionLayout.tabs,
    closed: attachment.closed,
    open: (key) => attachment.openTab(key, mounted.view()),
    side: () => side,
    onEmptied: () => {
      if (!side.opened()) return
      side.toggle()
    },
  })

  onCleanup(attachment.region(region))

  const drag = createPaneDrag({
    shown: (pane) => pane === "side" && region.pane(pane).keys().length > 0,
    drop: (key, target) => sessionLayout.tabs().move(key, target.pane, target.before),
  })

  useNewSessionCommands({
    restoreFocus: model.restoreFocus,
    review: { toggle: side.toggle },
    project: {
      empty: project.empty,
      open: () => location({ projectsOnly: true }),
    },
    workspace: {
      enabled: workspace.bar.visible,
      cycle: workspace.selection.cycle,
    },
  })
  // Focus once the draft loads. restoreFocus reads the stored cursor, so tracking it here would reapply
  // a stale cursor a frame after every key-up and yank the caret from a key pressed in that frame.
  createEffect(
    on(composer.ready, (ready) => {
      if (!ready) return

      // Search projects opened this draft; the picker returns focus to the composer when it closes.
      if (layout.draft.projectSearch.take()) location({ projectsOnly: true })
      else model.restoreFocus()
    }),
  )
  createEffect(() => {
    if (!composer.ready()) return
    untrack(() => {
      const text = search.prompt

      if (!text) return
      composer.adapter.state.set([{ type: "text", content: text, start: 0, end: text.length }], text.length)
      setSearch({ ...search, prompt: undefined })
    })
  })
  // Home already collected the message. Send it once a model can be resolved, instead of stopping on this draft.
  createEffect(() => {
    const online =
      server.conn.type !== "plugin" || !server.conn.managed || server.ctx.sdk.connection.status() === "connected"

    if (search.send !== "1" || !composer.ready() || !online || sent) return
    const text = composer.adapter.state
      .current()
      .map((part) => ("content" in part ? part.content : ""))
      .join("")
      .trim()

    if (!text) return
    sent = true
    untrack(() => {
      setSearch({ ...search, send: undefined }, { replace: true })
      model.submit()
    })
  })
  const ready = Promise.resolve()

  const [suspendUntilPromptReady] = createResource(
    () => composer.ready.promise ?? ready,
    (promise) => promise.then(() => true),
  )

  return (
    <PluginLinks session={mounted.view()}>
      <div class="relative size-full overflow-hidden flex flex-col">
        {suspendUntilPromptReady()}
        <div class="flex-1 min-h-0 flex flex-col gap-2 px-[var(--shell-inline-inset,8px)] pb-[var(--shell-bottom-inset,8px)] pt-[var(--shell-top-inset,8px)]">
          <div data-pane-row class="relative flex-1 min-h-0 flex flex-col md:flex-row gap-2">
            <Show when={desktop()}>
              <div class="absolute end-3 top-0 z-30 h-12 flex items-center" data-slot="session-review-toggle">
                <SessionHeaderActions
                  state={{
                    reviewLabel: language.t("command.review.toggle"),
                    reviewKeybind: command.keybindParts("review.toggle"),
                    reviewVisible: true,
                    reviewOpened: side.opened(),
                    onReviewToggle: side.toggle,
                  }}
                />
              </div>
            </Show>
            <div class="relative z-10 min-w-0 flex min-h-0 h-full flex-1 flex-col">
              <NewSessionView composer={model} project={project} workspace={workspace} location={location} />
            </div>
            <Show when={desktop() && side.opened()}>
              <SideRegion
                screen={mounted.screen}
                view={mounted.view()}
                region={region}
                sidebar={sidebar}
                present
                size={size}
                drag={drag}
                opened={() => true}
                active={() => true}
              />
            </Show>
          </div>
        </div>
      </div>
    </PluginLinks>
  )
}
