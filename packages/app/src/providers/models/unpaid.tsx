import { DialogBody, DialogHeader, DialogTitle, Dialog } from "@opencode/ui/dialog"
import { Badge } from "@opencode/ui/badge"
import { Icon } from "@opencode/ui/icon"
import { Tooltip } from "@opencode/ui/tooltip"
import { useDialog } from "@opencode/ui/context/dialog"
import { createMemo, onCleanup, onMount, type Component, For, Show } from "solid-js"
import { useLocal, type ModelSelection } from "@/providers/models/selection"
import { isFreeModel } from "@/providers/models/models"
import { decode64 } from "@/runtime/persistence/base64"
import { useLanguage } from "@/runtime/i18n/language"
import { ModelTooltip } from "./tooltip"

type ModelState = ModelSelection

const displayModelName = (name: string) => name.replace(/\s+(?:\(free\)|free)$/i, "")

export const DialogSelectModelUnpaid: Component<{ model?: ModelState }> = (props) => {
  const local = useLocal()
  const model = props.model ?? local.model
  const dialog = useDialog()
  const directory = () => decode64(local.slug())
  const language = useLanguage()
  const modelKey = (item: ReturnType<ModelState["list"]>[number]) => `${item.provider.id}:${item.id}`

  const currentKey = createMemo(() => {
    const c = model.current()

    return c ? `${c.provider.id}:${c.id}` : undefined
  })

  const freeModels = createMemo(() => model.list().filter(isFreeModel))

  const openProviders = () => {
    void import("@/providers/connect/dialog").then((x) => {
      const controller = x.useProviderConnectController()
      void dialog.show(() => (
        <x.DialogConnectProvider controller={controller} directory={directory()} selection={model} />
      ))
    })
  }

  const selectModel = (item: ReturnType<ModelState["list"]>[number]) => {
    model.set({ modelID: item.id, providerID: item.provider.id }, { recent: true })
    dialog.close()
  }

  // Focus starts on the dialog itself, outside the list, so listen at the
  // document level while the dialog is mounted instead of on the list container.
  let listEl: HTMLDivElement | undefined
  onMount(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return

      if (!listEl) return
      const buttons = Array.from(listEl.querySelectorAll<HTMLButtonElement>("button"))

      if (buttons.length === 0) return
      const index = buttons.findIndex((button) => button === document.activeElement)

      const next =
        index < 0 ? (e.key === "ArrowDown" ? 0 : buttons.length - 1) : index + (e.key === "ArrowDown" ? 1 : -1)

      buttons[(next + buttons.length) % buttons.length]?.focus()
      e.preventDefault()
    }

    document.addEventListener("keydown", handleKeyDown)
    onCleanup(() => document.removeEventListener("keydown", handleKeyDown))
  })

  return (
    <Dialog
      fit
      containerClass="!h-auto max-h-[calc(100vh_-_16px)] !w-[min(calc(100vw_-_16px),640px)]"
      class="[font-family:var(--v2-font-family-sans)] [&_[data-slot=dialog-header]]:!px-5 [&_[data-slot=dialog-header-title]]:!text-[15px] [&_[data-slot=dialog-header-title]]:!tracking-[-0.13px]"
    >
      <DialogHeader closeLabel={language.t("common.close")}>
        <DialogTitle>{language.t("dialog.model.select.title")}</DialogTitle>
      </DialogHeader>
      <DialogBody class="max-h-[calc(100vh_-_68px)] min-h-0 flex-none gap-0 overflow-y-auto px-2 pb-2">
        <div ref={listEl} class="flex min-h-0 flex-col">
          <div data-section="free-models" class="flex w-full flex-col items-start pb-3">
            <div class="flex h-8 w-full flex-none select-none flex-row items-center px-3 pb-2">
              <div class="flex h-5 items-center text-[13px] font-[440] leading-5 tracking-[-0.04px] text-v2-text-text-muted [font-family:var(--v2-font-family-sans)] [font-variant-numeric:tabular-nums] [font-variation-settings:'slnt'_0]">
                {language.t("dialog.model.unpaid.freeModels.title")}
              </div>
            </div>
            <For each={freeModels()}>
              {(item) => (
                <Tooltip
                  class="w-full"
                  placement="right-start"
                  gutter={6}
                  openDelay={0}
                  contentStyle={{ "font-family": "var(--v2-font-family-sans)" }}
                  value={
                    <ModelTooltip
                      model={{ ...item, name: displayModelName(item.name) }}
                      latest={item.latest}
                      free={isFreeModel(item)}
                      v2
                    />
                  }
                >
                  <button
                    type="button"
                    class="flex w-full scroll-my-3.5 flex-row items-center gap-1.5 rounded-md px-3 py-2 text-left text-[13px] font-[530] leading-5 tracking-[-0.04px] text-v2-text-text-base [font-family:var(--v2-font-family-sans)] [font-variation-settings:'slnt'_0] hover:bg-v2-overlay-simple-overlay-hover focus:bg-v2-overlay-simple-overlay-hover focus:outline-none"
                    onClick={() => selectModel(item)}
                  >
                    <span class="min-w-0 truncate">{displayModelName(item.name)}</span>
                    <Badge class="shrink-0">{language.t("model.tag.free")}</Badge>
                    <Show when={item.latest}>
                      <Badge class="shrink-0">{language.t("model.tag.latest")}</Badge>
                    </Show>
                    <Show when={currentKey() === modelKey(item)}>
                      <Icon name="check" class="ml-auto size-4 shrink-0 text-v2-icon-icon-base" />
                    </Show>
                  </button>
                </Tooltip>
              )}
            </For>
          </div>

          <button
            type="button"
            class="flex h-8 w-full scroll-my-3.5 items-center justify-start rounded-md px-3 text-left text-[13px] font-[440] leading-5 tracking-[-0.04px] text-v2-text-text-muted [font-family:var(--v2-font-family-sans)] [font-variation-settings:'slnt'_0] hover:bg-v2-overlay-simple-overlay-hover focus:bg-v2-overlay-simple-overlay-hover focus:outline-none"
            onClick={() => openProviders()}
          >
            {language.t("dialog.model.unpaid.viewMoreProviders")}
          </button>
        </div>
      </DialogBody>
    </Dialog>
  )
}
