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

export type PersonalProvider = {
  id: string
  /** The ID the provider has in the catalog. */
  providerID: string
  name: string
  baseURL: string
  models: ReadonlyArray<string>
  headers?: Readonly<Record<string, string>>
  names?: Readonly<Record<string, string>>
}

/** One model per line: `id`, or `id | Display name`. */
const parseModels = (text: string) => {
  const rows = text
    .split("\n")
    .map((line) => line.split("|").map((part) => part.trim()))
    .filter((parts) => parts[0])
  return {
    models: rows.map((parts) => parts[0]),
    names: Object.fromEntries(rows.flatMap((parts) => (parts[1] ? [[parts[0], parts[1]] as const] : []))),
  }
}

/** One header per line: `Name: value`. */
const parseHeaders = (text: string) =>
  Object.fromEntries(
    text
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .flatMap((line) => {
        const at = line.indexOf(":")
        return at > 0 ? [[line.slice(0, at).trim(), line.slice(at + 1).trim()] as const] : []
      }),
  )

/**
 * Adds an OpenAI-compatible provider that only the signed-in member can see and use, or edits one they added.
 * Without a key typed in, an edit keeps the key already stored.
 */
export function DialogPersonalProvider(props: { provider?: PersonalProvider; onSaved: () => void }) {
  const dialog = useDialog()
  const language = useLanguage()
  const sdk = useServerSDK()
  const editing = props.provider
  const [state, setState] = createStore({
    id: editing?.id ?? "",
    name: editing?.name ?? "",
    baseURL: editing?.baseURL ?? "",
    models: (editing?.models ?? []).map((id) => (editing?.names?.[id] ? `${id} | ${editing.names[id]}` : id)).join("\n"),
    headers: Object.entries(editing?.headers ?? {})
      .map(([key, value]) => `${key}: ${value}`)
      .join("\n"),
    key: "",
    pending: false,
  })

  const parsed = () => parseModels(state.models)

  const save = async () => {
    setState("pending", true)
    await sdk.api.credential.customProvider
      .save({
        providerID: state.id.trim(),
        name: state.name.trim(),
        baseURL: state.baseURL.trim(),
        models: parsed().models,
        names: parsed().names,
        headers: parseHeaders(state.headers),
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
        <DialogTitleGroup title={language.t(editing ? "settings.providers.personal.edit" : "settings.providers.personal.add")} />
      </DialogHeader>
      <DialogBody>
        <form
          data-component="personal-provider"
          data-scrollable
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
              disabled={!!editing}
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
              placeholder="model-a&#10;model-b | Display name"
              spellcheck={false}
              value={state.models}
              onInput={(event) => setState("models", event.currentTarget.value)}
            />
            <span class="personal-provider-hint">{language.t("settings.providers.personal.models.hint")}</span>
          </label>
          <label>
            {language.t("settings.providers.personal.headers")}
            <textarea
              rows={2}
              placeholder="X-Team: my-team"
              spellcheck={false}
              value={state.headers}
              onInput={(event) => setState("headers", event.currentTarget.value)}
            />
            <span class="personal-provider-hint">{language.t("settings.providers.personal.headers.hint")}</span>
          </label>
          <label>
            {language.t(editing ? "settings.providers.personal.key.replace" : "settings.providers.personal.key")}
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
              disabled={state.pending || !state.name.trim() || !state.id.trim() || !state.baseURL.trim() || parsed().models.length === 0}
            >
              {language.t("common.save")}
            </Button>
          </div>
        </form>
      </DialogBody>
    </Dialog>
  )
}
