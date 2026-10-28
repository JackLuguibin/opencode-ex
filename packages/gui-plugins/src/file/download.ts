import type { OpenCodeClient } from "@opencode/client/promise"
import { showToast, toaster } from "@opencode/ui/toast"
import { getFilename } from "@opencode/util/path"

export type FileMenuTarget = {
  /** Absolute path on the server, for copy and open-in-app. */
  absolute: string
  /** Workspace-relative path, or "" for the workspace root. */
  relative: string
  directory: boolean
}

export function downloadWorkspaceEntry(input: {
  client: OpenCodeClient
  root: string
  path: string
  folder: boolean
  preparing: string
  failed: string
  /** Saved filename without an extension. Folders get `.zip`. Defaults to the path's own name. */
  filename?: string
  /** Location-relative paths to keep. Omit it to include the whole folder. */
  paths?: readonly string[]
}) {
  const name = downloadName(
    input.filename ||
      (input.folder ? getFilename(input.path) || getFilename(input.root) : getFilename(input.path)) ||
      "download",
  )

  const toast = showToast({ title: input.preparing, variant: "loading", persistent: true })
  const location = { directory: input.root }
  const archived = archiveRequest(location, input.path, input.paths)

  const request = input.folder
    ? input.client.file.archive(archived).then((bytes) => {
        saveBytes(`${name}.zip`, bytes, "application/zip")
      })
    : input.client.file.read({ path: input.path, location }).then((bytes) => {
        saveBytes(name, bytes, "application/octet-stream")
      })

  return request
    .catch((err) => {
      showToast({
        variant: "error",
        title: input.failed,
        description: err instanceof Error ? err.message : String(err),
      })
    })
    .finally(() => {
      toaster.dismiss(toast)
    })
}

function archiveRequest(
  location: { directory: string },
  path: string,
  paths: readonly string[] | undefined,
) {
  if (paths && paths.length > 0) {
    if (path) return { location, path, paths }

    return { location, paths }
  }

  if (path) return { location, path }

  return { location }
}

function downloadName(name: string) {
  const clean = name.replace(/[\\/:*?"<>|]/g, "-").trim()

  return clean || "download"
}

function saveBytes(filename: string, bytes: Uint8Array, type: string) {
  const body = new ArrayBuffer(bytes.byteLength)
  new Uint8Array(body).set(bytes)
  const blob = new Blob([body], { type })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement("a")
  anchor.href = url
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
  URL.revokeObjectURL(url)
}
