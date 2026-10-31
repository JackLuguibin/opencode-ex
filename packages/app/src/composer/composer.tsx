import { Show, createEffect, createMemo, createSignal } from "solid-js"
import { Dynamic } from "solid-js/web"
import { createMediaQuery } from "@solid-primitives/media"
import { Button } from "@opencode/ui/button"
import { useDialog } from "@opencode/ui/context/dialog"
import { Icon } from "@opencode/ui/icon"
import { Keybind } from "@opencode/ui/keybind"
import { Slash } from "@opencode/ui/slash"
import { consoleModelGroup } from "@/providers/models/provider-group"
import { consoleProviderName } from "@/providers/catalog/console"
import { Tooltip } from "@opencode/ui/tooltip"
import { ComposerEditor } from "./editor/editor"
import { DialogSelectModel, ModelSelectorDrawer } from "@/providers/models/select-dialog"
import { DialogSelectModelNext, ModelSelectorDrawerNext } from "@/providers/models/select-dialog-next"
import { projectSettingsKey, useSettings } from "@/settings/model"
import { useWorkspaceLocation } from "@/workspaces/location"
import { useServerSDK } from "@/runtime/server/client"
import { ScopedKey } from "@/runtime/server/scope"
import { useParams } from "@solidjs/router"
import { ModelDetails } from "@/providers/models/details"
import { createModelUsage } from "@/usage/model"
import { formatKeybind, useCommand } from "@/shell/commands/command"
import { useLanguage } from "@/runtime/i18n/language"
import type { ComposerModel } from "./model"
import type { NewSessionComposerAdapter } from "./adapter"

export function Composer(props: {
  class?: string
  model: ComposerModel
  borderUnderlay?: boolean
  readOnly?: boolean
  suggestionBoundary?: () => HTMLElement | undefined
}) {
  const command = useCommand()
  const language = useLanguage()

  const modelName = () => {
    const preview = props.model.model.preview

    if (preview) return preview.model
    const selection = props.model.model.selection
    const model = selection.current()

    if (model) return model.name
    const key = selection.key()

    if (key) return language.t("dialog.model.unavailable", { model: key.modelID })

    return language.t("dialog.model.select.title")
  }

  return (
    <div class="flex flex-col gap-3">
      <ComposerEditor
        controller={props.model}
        borderUnderlay={props.borderUnderlay}
        readOnly={props.readOnly}
        class={props.class}
        modelControlsVisible={!props.model.model.loading || !!props.model.model.preview}
        attachKeybind={command.keybindParts("file.attach")}
        attachShortcut={command.keybind("file.attach")}
        alternateKeybind={[formatKeybind("mod", language.t), "↵"]}
        exitShellKeybind={[formatKeybind("esc", language.t)]}
        suggestionBoundary={props.suggestionBoundary}
        permissionControl={<ComposerAutoAccept draft={props.model.autoAccept} />}
        modelControl={
          <ComposerModelControl
            loading={props.model.model.loading}
            preview={!!props.model.model.preview}
            title={language.t("command.model.choose")}
            keybind={command.keybindParts("model.choose")}
            model={props.model.model.selection}
            providerName={props.model.model.preview?.provider ?? props.model.model.providerName}
            modelName={modelName()}
            onClose={props.model.restoreFocus}
          />
        }
      />
    </div>
  )
}

// Approves this session's permission requests without asking. It sits above the project's choice. Before the session
// exists (a draft or Home) the choice is held by the draft and becomes the session's when it is created.
function ComposerAutoAccept(props: { draft?: NewSessionComposerAdapter["autoAccept"] }) {
  const language = useLanguage()
  const settings = useSettings()
  const serverSDK = useServerSDK()
  const params = useParams()
  const location = useWorkspaceLocation()
  const session = () => (params.id ? ScopedKey.from(serverSDK.scope, params.id) : undefined)
  const project = () => projectSettingsKey(serverSDK.scope, location().current?.project.id)
  const on = () =>
    props.draft
      ? (props.draft.value() ?? settings.permissions.autoApproves(project()))
      : settings.permissions.autoApproves(project(), session())
  const toggle = () => {
    if (props.draft) return props.draft.set(!on())
    const key = session()
    if (key) settings.permissions.setAutoApproveSession(key, !on())
  }

  return (
    <Show when={props.draft || session()}>
      <Button
        data-action="composer-auto-accept"
        variant="ghost-muted"
        size="normal"
        style={{ height: "28px" }}
        class="shrink-0 gap-1 whitespace-nowrap ![font-weight:440]"
        classList={{ "!bg-v2-overlay-simple-overlay-hover !text-v2-text-text-base": on() }}
        aria-pressed={on()}
        onMouseDown={(event: MouseEvent) => event.preventDefault()}
        onClick={toggle}
      >
        <Show when={on()}>
          <Icon name="circle-check" size="small" />
        </Show>
        {language.t("command.permissions.autoaccept.enable")}
        <span class="text-v2-text-text-faint">
          {on() ? language.t("project.settings.autoAccept.on") : language.t("project.settings.autoAccept.off")}
        </span>
      </Button>
    </Show>
  )
}

function ComposerModelControl(props: {
  loading: boolean
  preview: boolean
  title: string
  keybind: string[]
  model: ComposerModel["model"]["selection"]
  providerName?: string
  modelName: string
  onClose: () => void
}) {
  // A preview paints the chip in its resting state, and the loaded names replace it in place.
  const shouldAnimate = createMemo<boolean>((previous) => previous ?? (props.loading && !props.preview))
  const mobile = createMediaQuery("(max-width: 767px)")
  const dialog = useDialog()
  const settings = useSettings()
  const managed = createMemo(() => consoleModelGroup(props.model.list()))
  const usage = createModelUsage()

  const open = (detail: number) => {
    const Picker = settings.general.newModelPicker() ? DialogSelectModelNext : DialogSelectModel
    // A pointer open keeps focus in the composer, so the dialog returns it to the caret. A keyboard open
    // (a click with no pointer presses) returns focus to this trigger instead of moving it to the editor.
    void dialog.show(() => <Picker model={props.model} />, detail === 0 ? undefined : props.onClose)
  }

  // A previewed chip is visible before the catalog loads, so a click on it opens the dialog once loading finishes.
  const [deferred, setDeferred] = createSignal<number>()

  createEffect(() => {
    const detail = deferred()

    if (props.loading || detail === undefined) return
    setDeferred(undefined)
    open(detail)
  })

  const providerName = (provider: { id: string; name: string }) => {
    const group = managed()

    return group?.providers.some((item) => item.id === provider.id)
      ? consoleProviderName(group, provider.name)
      : provider.name
  }

  const content = () => (
    <>
      <span class="flex min-w-0 whitespace-nowrap leading-4">
        <Show when={props.providerName}>
          {(name) => (
            <>
              <span class="shrink-0 text-v2-text-text-faint">{name()}</span>
              <Slash />
              <span class="sr-only">{" / "}</span>
            </>
          )}
        </Show>
        <span class="truncate">{props.modelName}</span>
      </span>
      <span class="-ml-0.5 -mr-1 flex shrink-0">
        <Icon name="chevron-down" />
      </span>
    </>
  )

  return (
    <Show when={!props.loading || props.preview}>
      <Tooltip
        inactive={mobile()}
        openDelay={750}
        contentClass={props.model.current() ? "!p-0 rounded-md" : undefined}
        placement="top"
        gutter={4}
        value={
          <Show
            when={props.model.current()}
            fallback={
              <>
                {props.title}
                <Keybind keys={props.keybind} variant="neutral" />
              </>
            }
          >
            {(model) => (
              <div class="flex w-[188px] max-w-[calc(100vw-24px)] flex-col">
                <ModelDetails model={model()} provider={providerName(model().provider)} usage={usage(model())} />
                <div class="flex h-7 min-w-0 items-center gap-2 border-t-[0.5px] border-v2-border-border-base px-2">
                  <span class="min-w-0 flex-1 truncate text-v2-text-text-faint">{props.title}</span>
                  <Keybind keys={props.keybind} variant="neutral" />
                </div>
              </div>
            )}
          </Show>
        }
      >
        {/* While loading, the drawer would open on a catalog that isn't there yet, so the inert chip stands in. */}
        <Show
          when={mobile() && !props.loading}
          fallback={
            <Button
              data-action="composer-model"
              data-control-type="dialog"
              variant="ghost-muted"
              size="normal"
              class="min-w-0 max-w-[60cqw] justify-start ![font-weight:440]"
              classList={{ "animate-in fade-in": shouldAnimate() }}
              style={{ height: "28px" }}
              onMouseDown={(event: MouseEvent) => event.preventDefault()}
              onClick={(event: MouseEvent) => {
                if (!props.loading) return open(event.detail)

                // On mobile this inert chip stands in for the drawer trigger, so a click there is dropped.
                if (!mobile()) setDeferred(event.detail)
              }}
            >
              {content()}
            </Button>
          }
        >
          <Dynamic
            component={settings.general.newModelPicker() ? ModelSelectorDrawerNext : ModelSelectorDrawer}
            model={props.model}
            trigger={(triggerProps) => (
              <Button
                {...triggerProps}
                variant="ghost-muted"
                size="normal"
                style={{ height: "28px" }}
                class="min-w-0 max-w-[60cqw] justify-start ![font-weight:440]"
                classList={{ "animate-in fade-in": shouldAnimate() }}
                data-action="composer-model"
                data-control-type="drawer"
              >
                {content()}
              </Button>
            )}
            onClose={props.onClose}
          />
        </Show>
      </Tooltip>
    </Show>
  )
}
