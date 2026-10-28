import { createMemo, createResource, For, onCleanup, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { Icon } from "@opencode/ui/icon"
import { Loader } from "@opencode/ui/loader"
import { useDialog } from "@opencode/ui/context/dialog"
import { PluginConfirmDialog } from "@/runtime/plugin/dialogs"
import { IconButton } from "@opencode/ui/icon-button"
import { useLanguage } from "@/runtime/i18n/language"
import { useAccountOptional } from "@/identity/gate"
import { showToast } from "@/shell/notifications/toast"
import { formatServerError } from "@/runtime/server/errors"
import type { ServerCtx } from "@/runtime/server/runtime"
import "./view.css"

type Node = { path: string; name: string; directory: boolean; depth: number }

const IMAGE = /\.(png|jpe?g|gif|webp|svg|bmp)$/i

/**
 * The organization's shared space: files grouped under the folder of the member who uploaded them, with a preview.
 * Members' folders sit at the top level and are named by employee ID, so the top folder is the uploader.
 */
export function SharedSpace(props: { ctx: ServerCtx; directory: string }) {
  const language = useLanguage()
  const account = useAccountOptional()
  const dialog = useDialog()
  const [store, setStore] = createStore<{
    children: Record<string, Node[]>
    expanded: Record<string, boolean>
    selected?: string
  }>({ children: {}, expanded: {} })

  const location = () => ({ directory: props.directory })

  const load = (path: string, depth: number) =>
    props.ctx.sdk.api.file.list({ location: location(), path: path || undefined }).then((result) => {
      const nodes = result.data
        // Directory entries may end in a slash; paths are kept without it so parents derive correctly.
        .map((entry) => {
          const path = entry.path.replace(/\/+$/, "")

          return { path, name: path.split("/").pop() ?? path, directory: entry.type === "directory", depth }
        })
        .toSorted((a, b) => (a.directory === b.directory ? a.name.localeCompare(b.name) : a.directory ? -1 : 1))
      setStore("children", path, nodes)
    })

  const [root] = createResource(
    () => props.directory,
    () => load("", 0),
  )

  const toggle = (node: Node) => {
    const open = !store.expanded[node.path]
    setStore("expanded", node.path, open)
    if (open && !store.children[node.path]) void load(node.path, node.depth + 1)
  }

  // Members write only to their own subfolder of the shared space.
  const upload = () => {
    const employeeID = account?.session.employeeID
    if (!employeeID) return
    const input = document.createElement("input")
    input.type = "file"
    input.multiple = true
    input.onchange = () => {
      void Promise.all(
        Array.from(input.files ?? []).map(async (item) =>
          props.ctx.sdk.api.file.write({
            location: location(),
            path: `${employeeID}/${item.name}`,
            payload: new Uint8Array(await item.arrayBuffer()),
          }),
        ),
      )
        .then(() => {
          showToast({ variant: "success", title: language.t("home.project.upload.done") })
          setStore("children", {})
          setStore("expanded", {})
          return load("", 0)
        })
        .catch((error: unknown) => {
          showToast({
            variant: "error",
            title: language.t("common.requestFailed"),
            description: formatServerError(error, language.t),
          })
        })
    }
    input.click()
  }

  // Admins can delete anything; members only their own folder, which is also all the server lets them change.
  const canDelete = (path: string) =>
    !!account && (account.session.organizationAdmin || path.split("/")[0] === account.session.employeeID)

  const remove = (node: Node) =>
    dialog.show(() => (
      <PluginConfirmDialog
        options={{
          title: language.t("home.shared.delete.title", { name: node.name }),
          description: language.t("home.shared.delete.description"),
          confirm: language.t("common.delete"),
          danger: true,
        }}
        done={(confirmed) => {
          dialog.close()
          if (!confirmed) return
          const parent = node.path.split("/").slice(0, -1).join("/")

          void props.ctx.sdk.api.file
            .delete({ location: location(), path: node.path })
            .then(() => {
              if (store.selected?.startsWith(node.path)) setStore("selected", undefined)
              setStore("children", node.path, [])
              setStore("expanded", node.path, false)
              return load(parent, node.depth)
            })
            .catch((error: unknown) => {
              showToast({
                variant: "error",
                title: language.t("common.requestFailed"),
                description: formatServerError(error, language.t),
              })
            })
        }}
      />
    ))

  const rows = createMemo(() => {
    const out: Node[] = []
    const walk = (path: string) => {
      for (const node of store.children[path] ?? []) {
        out.push(node)
        if (node.directory && store.expanded[node.path]) walk(node.path)
      }
    }
    walk("")

    return out
  })

  const uploader = (path: string) => path.split("/")[0]

  const [preview] = createResource(
    () => store.selected,
    async (path) => {
      const bytes = await props.ctx.sdk.api.file.read({ location: location(), path })
      if (IMAGE.test(path)) {
        const body = new ArrayBuffer(bytes.byteLength)
        new Uint8Array(body).set(bytes)

        return { image: URL.createObjectURL(new Blob([body])) }
      }
      const text = new TextDecoder("utf-8", { fatal: true })
      try {
        return { text: text.decode(bytes) }
      } catch {
        return {}
      }
    },
  )

  onCleanup(() => {
    const value = preview.latest

    if (value?.image) URL.revokeObjectURL(value.image)
  })

  return (
    <div class="shared-space">
      <div class="shared-space-list-pane">
        <div class="shared-space-header">
          <span class="truncate">{language.t("home.shared.title")}</span>
          <IconButton
            variant="ghost-muted"
            size="small"
            icon={<Icon name="cloud-upload" />}
            aria-label={language.t("home.project.upload")}
            onClick={upload}
          />
        </div>
        <div class="shared-space-list" role="tree" aria-label={language.t("home.shared.title")}>
          <Show when={!root.loading} fallback={<Loader />}>
            <For each={rows()} fallback={<div class="shared-space-empty">{language.t("home.shared.empty")}</div>}>
              {(node) => (
                <div
                  role="treeitem"
                  class="shared-space-row"
                  data-selected={store.selected === node.path ? "" : undefined}
                >
                  <button
                    type="button"
                    class="shared-space-item"
                    style={{ "padding-inline-start": `${8 + node.depth * 16}px` }}
                    onClick={() => (node.directory ? toggle(node) : setStore("selected", node.path))}
                  >
                    <Icon
                      name={node.directory ? (store.expanded[node.path] ? "chevron-down" : "chevron-right") : "file"}
                      size="small"
                    />
                    <span class="truncate">{node.name}</span>
                    <Show when={node.depth === 0 && node.directory}>
                      <span class="shared-space-owner">{language.t("home.shared.uploader", { name: node.name })}</span>
                    </Show>
                  </button>
                  <Show when={canDelete(node.path)}>
                    <IconButton
                      class="shared-space-delete"
                      variant="ghost-muted"
                      size="small"
                      icon={<Icon name="trash" />}
                      aria-label={language.t("common.delete")}
                      onClick={() => remove(node)}
                    />
                  </Show>
                </div>
              )}
            </For>
          </Show>
        </div>
      </div>
      <div class="shared-space-preview">
        <Show when={store.selected} fallback={<div class="shared-space-empty">{language.t("home.shared.select")}</div>}>
          {(path) => (
            <>
              <div class="shared-space-meta">
                <span class="truncate">{path().split("/").pop()}</span>
                <span class="shared-space-owner">{language.t("home.shared.uploader", { name: uploader(path()) })}</span>
              </div>
              <Show when={!preview.loading} fallback={<Loader />}>
                <Show when={preview.latest?.image}>{(src) => <img src={src()} alt={path()} />}</Show>
                <Show when={preview.latest?.text !== undefined}>
                  <pre>{preview.latest?.text}</pre>
                </Show>
                <Show when={!preview.latest?.image && preview.latest?.text === undefined}>
                  <div class="shared-space-empty">{language.t("home.shared.noPreview")}</div>
                </Show>
              </Show>
            </>
          )}
        </Show>
      </div>
    </div>
  )
}
