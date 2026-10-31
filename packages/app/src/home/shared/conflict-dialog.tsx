import { Button } from "@opencode/ui/button"
import { useDialog } from "@opencode/ui/context/dialog"
import { Dialog, DialogBody, DialogHeader, DialogTitleGroup } from "@opencode/ui/dialog"
import { useLanguage } from "@/runtime/i18n/language"

export type Conflict = "replace" | "rename" | "skip"

/** Asked when an upload would land on a file that already exists. */
export function DialogUploadConflict(props: { name: string; done: (choice: Conflict) => void }) {
  const dialog = useDialog()
  const language = useLanguage()
  const choose = (choice: Conflict) => {
    dialog.close()
    props.done(choice)
  }

  return (
    <Dialog fit>
      <DialogHeader>
        <DialogTitleGroup title={language.t("home.shared.conflict.title", { name: props.name })} />
      </DialogHeader>
      <DialogBody>
        <p>{language.t("home.shared.conflict.description")}</p>
        <div class="flex items-center justify-end gap-2">
          <Button type="button" variant="ghost" onClick={() => choose("skip")}>
            {language.t("home.shared.conflict.skip")}
          </Button>
          <Button type="button" variant="ghost" onClick={() => choose("rename")}>
            {language.t("home.shared.conflict.keep")}
          </Button>
          <Button type="button" variant="contrast" onClick={() => choose("replace")}>
            {language.t("home.shared.conflict.replace")}
          </Button>
        </div>
      </DialogBody>
    </Dialog>
  )
}
