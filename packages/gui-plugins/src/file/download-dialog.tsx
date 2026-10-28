import type { JSX } from "solid-js"
import type { OpenCodeClient } from "@opencode/client/promise"
import { Checkbox } from "@opencode/ui/checkbox"
import { showToast } from "@opencode/ui/toast"
import { getFilename } from "@opencode/util/path"
import { usePlugin } from "@opencode/plugin/gui"
import { For, Show, createMemo, onCleanup, onMount } from "solid-js"
import { createStore, produce } from "solid-js/store"
import { downloadWorkspaceEntry } from "./download"
import { chosenPaths, selectionMark, type PickNode, type SelectionMark } from "./download-selection"

type ListedNode = PickNode & {
  name: string
  expanded: boolean
  loading: boolean
}

type PickerStore = {
  nodes: Record<string, ListedNode>
  roots: string[]
  loading: boolean
  error: string
}

export function chooseDownload(input: {
  client: OpenCodeClient
  root: string
  path: string
  folder: boolean
  preparing: string
  failed: string
  filename?: string
  open: (render: (dialog: { close: () => void }) => JSX.Element) => void
}) {
  if (!input.folder) return downloadWorkspaceEntry(input)

  input.open((dialog) => (
    <DownloadPicker
      client={input.client}
      root={input.root}
      path={input.path}
      name={input.filename || getFilename(input.path) || getFilename(input.root) || "download"}
      preparing={input.preparing}
      failed={input.failed}
      onClose={dialog.close}
    />
  ))

  return Promise.resolve()
}

function DownloadPicker(props: {
  client: OpenCodeClient
  root: string
  path: string
  name: string
  preparing: string
  failed: string
  onClose: () => void
}) {
  const ctx = usePlugin()
  const [store, setStore] = createStore<PickerStore>({ nodes: {}, roots: [], loading: true, error: "" })
  const controller = new AbortController()

  onCleanup(() => controller.abort())

  const rows = createMemo(() => {
    const next: { path: string; depth: number; mark: SelectionMark }[] = []

    for (const root of store.roots) pushRows(store.nodes, root, 0, next)

    return next
  })

  const picked = createMemo(() => chosenPaths(store.nodes, store.roots))

  onMount(() => {
    void load(props.path, true)
  })

  const load = async (path: string, initial: boolean) => {
    const checked = initial || store.nodes[path]?.checked === true

    if (!initial) setStore("nodes", path, { expanded: true, loading: true })

    try {
      const listed = await props.client.file.list(
        path ? { location: { directory: props.root }, path } : { location: { directory: props.root } },
        { signal: controller.signal },
      )

      if (controller.signal.aborted) return

      const children = listed.data.flatMap((entry) => {
        const relative = entry.path.replaceAll("\\", "/").replace(/^\/+|\/+$/g, "")

        if (!relative) return []

        return [entryNode(relative, entry.type, checked)]
      })

      setStore(
        produce((draft) => {
          draft.loading = false
          draft.error = ""

          if (initial) draft.roots = children.map((child) => child.path)

          const parent = draft.nodes[path]

          if (parent) {
            parent.loading = false
            parent.listed = true
            parent.expanded = true
            parent.children = children.map((child) => child.path)
          }

          for (const child of children) draft.nodes[child.path] = child
        }),
      )
    } catch (err) {
      if (controller.signal.aborted) return

      const description = err instanceof Error ? err.message : String(err)

      if (initial) {
        setStore({ loading: false, error: description })

        return
      }

      setStore("nodes", path, { expanded: false, loading: false })
      showToast({ variant: "error", title: props.failed, description })
    }
  }

  const toggleExpand = (path: string) => {
    const node = store.nodes[path]

    if (!node || node.type !== "directory" || node.loading) return

    if (node.expanded) {
      setStore("nodes", path, "expanded", false)

      return
    }

    if (node.listed) {
      setStore("nodes", path, "expanded", true)

      return
    }

    void load(path, false)
  }

  const setBranch = (paths: readonly string[], checked: boolean) => {
    setStore(
      "nodes",
      produce((draft) => {
        const visit = (path: string) => {
          const node = draft[path]

          if (!node) return
          node.checked = checked

          for (const child of node.children) visit(child)
        }

        for (const path of paths) visit(path)
      }),
    )
  }

  const confirm = () => {
    const selection = picked()

    if (selection && selection.length === 0) return
    props.onClose()

    const onlyPath = selection?.length === 1 ? selection[0] : undefined
    const only = onlyPath ? store.nodes[onlyPath] : undefined

    if (only?.type === "file") {
      void downloadWorkspaceEntry({
        client: props.client,
        root: props.root,
        path: only.path,
        folder: false,
        preparing: props.preparing,
        failed: props.failed,
        filename: only.name,
      })

      return
    }

    if (only?.type === "directory") {
      void downloadWorkspaceEntry({
        client: props.client,
        root: props.root,
        path: only.path,
        folder: true,
        preparing: props.preparing,
        failed: props.failed,
        filename: only.name,
      })

      return
    }

    void downloadWorkspaceEntry({
      client: props.client,
      root: props.root,
      path: props.path,
      folder: true,
      preparing: props.preparing,
      failed: props.failed,
      filename: props.name,
      paths: selection,
    })
  }

  return (
    <ctx.ui.Dialog
      title={ctx.t("download.choose.title", { name: props.name })}
      description={ctx.t("download.choose.description")}
      size="normal"
      footer={
        <>
          <ctx.ui.Button variant="ghost" onClick={props.onClose}>
            {ctx.t("common.cancel")}
          </ctx.ui.Button>
          <ctx.ui.Button
            variant="contrast"
            disabled={store.loading || store.roots.length === 0 || picked()?.length === 0}
            onClick={confirm}
          >
            {ctx.t("download.choose.action")}
          </ctx.ui.Button>
        </>
      }
    >
      <Show
        when={!store.loading}
        fallback={
          <div class="flex justify-center py-6">
            <ctx.ui.Loader />
          </div>
        }
      >
        <Show when={!store.error} fallback={<p class="text-13-regular text-text-weak">{store.error}</p>}>
          <Show
            when={store.roots.length > 0}
            fallback={<p class="text-13-regular text-text-weak">{ctx.t("download.choose.empty")}</p>}
          >
            <div class="mb-2 flex gap-2">
              <ctx.ui.Button variant="ghost" size="small" onClick={() => setBranch(store.roots, true)}>
                {ctx.t("download.choose.all")}
              </ctx.ui.Button>
              <ctx.ui.Button variant="ghost" size="small" onClick={() => setBranch(store.roots, false)}>
                {ctx.t("download.choose.none")}
              </ctx.ui.Button>
            </div>
            <div class="flex flex-col" data-scrollable>
              <For each={rows()}>
                {(row) => {
                  const node = () => store.nodes[row.path]

                  return (
                    <div
                      class="flex min-w-0 items-center gap-1 py-0.5"
                      style={{ "padding-inline-start": `${row.depth * 16}px` }}
                    >
                      <Show when={node()?.type === "directory"} fallback={<span class="size-6 shrink-0" />}>
                        <ctx.ui.IconButton
                          icon={node()?.expanded ? "chevron-down" : "chevron-right"}
                          label={ctx.t(node()?.expanded ? "download.collapse" : "download.expand", {
                            name: node()?.name ?? "",
                          })}
                          size="small"
                          busy={node()?.loading}
                          onClick={() => toggleExpand(row.path)}
                        />
                      </Show>
                      <Checkbox
                        class="min-w-0 flex-1"
                        checked={row.mark === "on"}
                        indeterminate={row.mark === "mixed"}
                        onChange={() => setBranch([row.path], row.mark !== "on")}
                      >
                        <span class="truncate">{node()?.name}</span>
                      </Checkbox>
                    </div>
                  )
                }}
              </For>
            </div>
          </Show>
        </Show>
      </Show>
    </ctx.ui.Dialog>
  )
}

function entryNode(path: string, type: "file" | "directory", checked: boolean): ListedNode {
  return {
    path,
    name: getFilename(path) || path,
    type,
    checked,
    listed: false,
    expanded: false,
    loading: false,
    children: [],
  }
}

function pushRows(
  nodes: Record<string, ListedNode>,
  path: string,
  depth: number,
  rows: { path: string; depth: number; mark: SelectionMark }[],
) {
  const node = nodes[path]

  if (!node) return
  rows.push({ path, depth, mark: selectionMark(nodes, path) })

  if (node.type !== "directory" || !node.expanded) return

  for (const child of node.children) pushRows(nodes, child, depth + 1, rows)
}
