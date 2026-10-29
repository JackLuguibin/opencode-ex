import { createStore } from "solid-js/store"
import { Button } from "@opencode/ui/button"
import { useDialog } from "@opencode/ui/context/dialog"
import { Dialog, DialogBody, DialogHeader, DialogTitleGroup } from "@opencode/ui/dialog"
import { TextInput } from "@opencode/ui/text-input"
import { useLanguage } from "@/runtime/i18n/language"
import { useServerSDK } from "@/runtime/server/client"
import { formatServerError } from "@/runtime/server/errors"
import { showToast } from "@/shell/notifications/toast"
import "./personal-provider.css"

/** Adds an OpenAI-compatible provider that only the signed-in member can see and use. */
export function DialogPersonalProvider(props: { onSaved: () => void }) {
  const dialog = useDialog()
  const language = useLanguage()
  const sdk = useServerSDK()
  const [state, setState] = createStore({ id: "", name: "", baseURL: "", models: "", key: "", pending: false })

  const models = () =>
    state.models
      .split(/[\n,]/)
      .map((item) => item.trim())
      .filter(Boolean)

  const save = async () => {
    setState("pending", true)
    await sdk.api.credential.customProvider
      .save({
        providerID: state.id.trim(),
        name: state.name.trim(),
        baseURL: state.baseURL.trim(),
        models: models(),
        key: state.key.trim() || undefined,
      })
      .then(() => {
        props.onSaved()
        dialog.close()
      })
      .catch((error) =>
        showToast({
          title: language.t("common.requestFailed"),
          description: formatServerError(error, language.t),
        }),
      )
    setState("pending", false)
  }

  return (
    <Dialog fit>
      <DialogHeader>
        <DialogTitleGroup title={language.t("settings.providers.personal.add")} />
      </DialogHeader>
      <DialogBody>
        <form
          data-component="personal-provider"
          onSubmit={(event) => {
            event.preventDefault()
            void save()
          }}
        >
          <p>{language.t("settings.providers.personal.description")}</p>
          <label>
            {language.t("settings.providers.personal.name")}
            <TextInput
              required
              autocomplete="off"
              value={state.name}
              onInput={(event) => setState("name", event.currentTarget.value)}
            />
          </label>
          <label>
            {language.t("settings.providers.personal.id")}
            <TextInput
              required
              autocomplete="off"
              placeholder="my-llm"
              spellcheck={false}
              value={state.id}
              onInput={(event) => setState("id", event.currentTarget.value)}
            />
          </label>
          <label>
            {language.t("settings.providers.personal.baseURL")}
            <TextInput
              required
              autocomplete="off"
              placeholder="https://api.example.com/v1"
              spellcheck={false}
              value={state.baseURL}
              onInput={(event) => setState("baseURL", event.currentTarget.value)}
            />
          </label>
          <label>
            {language.t("settings.providers.personal.models")}
            <textarea
              required
              rows={4}
              placeholder="model-a&#10;model-b"
              spellcheck={false}
              value={state.models}
              onInput={(event) => setState("models", event.currentTarget.value)}
            />
          </label>
          <label>
            {language.t("settings.providers.personal.key")}
            <TextInput
              type="password"
              autocomplete="new-password"
              value={state.key}
              onInput={(event) => setState("key", event.currentTarget.value)}
            />
          </label>
          <div class="personal-provider-actions">
            <Button
              type="submit"
              variant="contrast"
              disabled={state.pending || !state.name.trim() || !state.id.trim() || !state.baseURL.trim() || models().length === 0}
            >
              {language.t("common.save")}
            </Button>
          </div>
        </form>
      </DialogBody>
    </Dialog>
  )
}
