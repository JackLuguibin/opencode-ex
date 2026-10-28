import type { JSX } from "solid-js"
import type { OpenCodeClient } from "@opencode/client/promise"
import { showToast } from "@opencode/ui/toast"
import { getFilename } from "@opencode/util/path"
import { usePlugin } from "@opencode/plugin/gui"
import type { FileMenuTarget } from "./download"

export function confirmDelete(input: {
  client: OpenCodeClient
  root: string
  target: FileMenuTarget
  failed: string
  open: (render: (dialog: { close: () => void }) => JSX.Element) => void
  /** Runs after the entry is gone, so the caller can refresh its listing. */
  onDeleted: () => void
}) {
  input.open((dialog) => <DeleteConfirm {...input} onClose={dialog.close} />)
}

function DeleteConfirm(props: Parameters<typeof confirmDelete>[0] & { onClose: () => void }) {
  const ctx = usePlugin()
  const name = getFilename(props.target.relative) || props.target.relative

  const remove = () => {
    props.onClose()
    void props.client.file
      .delete({ location: { directory: props.root }, path: props.target.relative })
      .then(props.onDeleted)
      .catch((err) => {
        showToast({
          variant: "error",
          title: props.failed,
          description: err instanceof Error ? err.message : String(err),
        })
      })
  }

  return (
    <ctx.ui.Dialog
      title={ctx.t("delete.title", { name })}
      description={ctx.t(props.target.directory ? "delete.directory" : "delete.file", { name })}
      size="normal"
      footer={
        <>
          <ctx.ui.Button variant="ghost" onClick={props.onClose}>
            {ctx.t("common.cancel")}
          </ctx.ui.Button>
          <ctx.ui.Button variant="contrast" onClick={remove}>
            {ctx.t("common.delete")}
          </ctx.ui.Button>
        </>
      }
    />
  )
}
