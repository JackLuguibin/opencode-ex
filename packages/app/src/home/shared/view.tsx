import { createMemo, createResource, For, onCleanup, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { FileIcon } from "@opencode/ui/file-icon"
import { Icon } from "@opencode/ui/icon"
import { Loader } from "@opencode/ui/loader"
import { useDialog } from "@opencode/ui/context/dialog"
import { PluginConfirmDialog } from "@/runtime/plugin/dialogs"
import { IconButton } from "@opencode/ui/icon-button"
import { PluginPromptDialog } from "@/runtime/plugin/dialogs"
import { useLanguage } from "@/runtime/i18n/language"
import { useAccountOptional } from "@/identity/gate"
import { showToast } from "@/shell/notifications/toast"
import { formatServerError } from "@/runtime/server/errors"
import type { ServerCtx } from "@/runtime/server/runtime"
import "./view.css"

type Node = { path: string; name: string; directory: boolean; depth: number }

const IMAGE = /\.(png|jpe?g|gif|webp|svg|bmp)$/i

/** The organization's shared space: folders anyone can create and upload into, with a preview. */
export function SharedSpace(props: { ctx: ServerCtx; directory: string }) {
  const language = useLanguage()
  const account = useAccountOptional()
  const dialog = useDialog()
  const [store, setStore] = createStore<{
    children: Record<string, Node[]>
    expanded: Record<string, boolean>
    selected?: string
    /** Where new folders and uploads go; empty is the top of the shared space. */
    folder: string
    /** The folder a drag is hovering, "" for the top of the shared space. */
    dropTarget?: string
  }>({ children: {}, expanded: {}, folder: "" })

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

  const join = (folder: string, name: string) => (folder ? `${folder}/${name}` : name)

  // Shows what a change made inside `folder` looks like without collapsing everything else.
  const refresh = (folder: string) => {
    if (folder) setStore("expanded", folder, true)

    return load(folder, folder ? folder.split("/").length : 0)
  }

  const fail = (error: unknown) =>
    showToast({
      variant: "error",
      title: language.t("common.requestFailed"),
      description: formatServerError(error, language.t),
    })

  const send = (folder: string, files: File[]) =>
    Promise.all(
      files.map(async (item) =>
        props.ctx.sdk.api.file.write({
          location: location(),
          path: join(folder, item.name),
          payload: new Uint8Array(await item.arrayBuffer()),
        }),
      ),
    )
      .then(() => {
        showToast({ variant: "success", title: language.t("home.project.upload.done") })

        return refresh(folder)
      })
      .catch(fail)

  const upload = (folder = store.folder) => {
    const input = document.createElement("input")
    input.type = "file"
    input.multiple = true
    input.onchange = () => void send(folder, Array.from(input.files ?? []))
    input.click()
  }

  const parentOf = (path: string) => path.split("/").slice(0, -1).join("/")

  // Moving is a copy followed by a delete; a folder can't go into itself or where it already is.
  const move = (from: string, folder: string) => {
    if (parentOf(from) === folder || folder === from || folder.startsWith(`${from}/`)) return
    const target = join(folder, from.split("/").pop() ?? from)

    void props.ctx.sdk.api.file
      .copy({ location: location(), path: from, to: target })
      .then(() => props.ctx.sdk.api.file.delete({ location: location(), path: from }))
      .then(() => {
        if (store.selected === from) setStore("selected", target)

        return Promise.all([refresh(folder), refresh(parentOf(from))])
      })
      .catch(fail)
  }

  // Files from the desktop are uploaded into the folder they land on; rows already in the space are moved there.
  const drop = (event: DragEvent, folder: string) => {
    event.preventDefault()
    event.stopPropagation()
    setStore("dropTarget", undefined)
    const moved = event.dataTransfer?.getData("application/x-shared-path")

    if (moved) return move(moved, folder)
    const files = Array.from(event.dataTransfer?.files ?? [])
    if (files.length > 0) void send(folder, files)
  }

  const dropProps = (folder: string) => ({
    onDragOver: (event: DragEvent) => {
      event.preventDefault()
      event.stopPropagation()
      if (store.dropTarget !== folder) setStore("dropTarget", folder)
    },
    onDragLeave: (event: DragEvent) => {
      const next = event.relatedTarget
      if (!(next instanceof Element && event.currentTarget instanceof Element && event.currentTarget.contains(next)))
        setStore("dropTarget", undefined)
    },
    onDrop: (event: DragEvent) => drop(event, folder),
  })

  const createFolder = () => {
    const folder = store.folder

    dialog.show(() => (
      <PluginPromptDialog
        options={{
          title: language.t("home.shared.folder.new"),
          placeholder: language.t("home.shared.folder.name"),
        }}
        done={(value) => {
          dialog.close()
          const name = value?.trim()
          if (!name) return

          void props.ctx.sdk.api.file
            .mkdir({ location: location(), path: join(folder, name) })
            .then(() => {
              setStore("folder", join(folder, name))

              return refresh(folder)
            })
            .catch(fail)
        }}
      />
    ))
  }

  // Everyone in the organization can change the shared space.
  const canDelete = () => !!account

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
              if (store.folder.startsWith(node.path)) setStore("folder", parent)
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
          <div class="flex items-center">
            <IconButton
              variant="ghost-muted"
              size="small"
              icon={<Icon name="folder-add-left" />}
              aria-label={language.t("home.shared.folder.new")}
              onClick={createFolder}
            />
            <IconButton
              variant="ghost-muted"
              size="small"
              icon={<Icon name="cloud-upload" />}
              aria-label={language.t("home.project.upload")}
              onClick={() => upload()}
            />
          </div>
        </div>
        <div class="shared-space-target">
          {language.t("home.shared.uploadTo", { folder: store.folder || language.t("home.shared.title") })}
        </div>
        <div
          class="shared-space-list"
          role="tree"
          aria-label={language.t("home.shared.title")}
          data-drop={store.dropTarget === "" ? "" : undefined}
          {...dropProps("")}
        >
          <Show when={!root.loading} fallback={<Loader />}>
            <For
              each={rows()}
              fallback={
                <div class="shared-space-empty" data-centered>
                  <Icon name="folder" />
                  <span>{language.t("home.shared.empty")}</span>
                  <button type="button" class="shared-space-upload" onClick={() => upload()}>
                    <Icon name="cloud-upload" size="small" />
                    {language.t("home.project.upload")}
                  </button>
                </div>
              }
            >
              {(node) => (
                <div
                  role="treeitem"
                  class="shared-space-row"
                  data-selected={store.selected === node.path ? "" : undefined}
                  data-drop={node.directory && store.dropTarget === node.path ? "" : undefined}
                  draggable={true}
                  onDragStart={(event) => event.dataTransfer?.setData("application/x-shared-path", node.path)}
                  {...(node.directory ? dropProps(node.path) : {})}
                >
                  <button
                    type="button"
                    class="shared-space-item"
                    style={{ "padding-inline-start": `${8 + node.depth * 16}px` }}
                    onClick={() => {
                      if (!node.directory) {
                        setStore("selected", node.path)
                        setStore("folder", node.path.split("/").slice(0, -1).join("/"))

                        return
                      }
                      setStore("folder", node.path)
                      toggle(node)
                    }}
                  >
                    <Show
                      when={node.directory}
                      fallback={<FileIcon node={{ path: node.path, type: "file" }} class="size-4 shrink-0" />}
                    >
                      <Icon name={store.expanded[node.path] ? "chevron-down" : "chevron-right"} size="small" />
                    </Show>
                    <span class="truncate">{node.name}</span>
                  </button>
                  <Show when={node.directory}>
                    <IconButton
                      class="shared-space-delete"
                      variant="ghost-muted"
                      size="small"
                      icon={<Icon name="cloud-upload" />}
                      aria-label={language.t("home.project.upload")}
                      onClick={() => {
                        setStore("folder", node.path)
                        upload(node.path)
                      }}
                    />
                  </Show>
                  <Show when={canDelete()}>
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
        <Show when={store.selected} fallback={
            <div class="shared-space-empty" data-centered>
              <Icon name="file" />
              <span>{language.t("home.shared.select")}</span>
            </div>
          }
        >
          {(path) => (
            <>
              <div class="shared-space-meta">
                <span class="truncate">{path().split("/").pop()}</span>
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
