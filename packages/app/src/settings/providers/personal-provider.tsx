import { For, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { Button } from "@opencode/ui/button"
import { useDialog } from "@opencode/ui/context/dialog"
import { Dialog, DialogBody, DialogHeader, DialogTitleGroup } from "@opencode/ui/dialog"
import { Icon } from "@opencode/ui/icon"
import { IconButton } from "@opencode/ui/icon-button"
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
export const parseModels = (text: string) => {
  const rows = text
    .split("\n")
    .map((line) => line.split("|").map((part) => part.trim()))
    .filter((parts) => parts[0])
  return {
    models: rows.map((parts) => parts[0]),
    names: Object.fromEntries(rows.flatMap((parts) => (parts[1] ? [[parts[0], parts[1]] as const] : []))),
  }
}

/** The reverse of `parseModels`, for editing. */
export const formatModels = (models: ReadonlyArray<string>, names?: Readonly<Record<string, string>>) =>
  models.map((id) => (names?.[id] ? `${id} | ${names[id]}` : id)).join("\n")

/** The reverse of `parseHeaders`, for editing. */
export const formatHeaders = (headers?: Readonly<Record<string, string>>) =>
  Object.entries(headers ?? {})
    .map(([name, value]) => `${name}: ${value}`)
    .join("\n")

/** One header per line: `Name: value`. */
export const parseHeaders = (text: string) =>
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
    models: (editing?.models ?? [""]).map((id) => ({ id, name: editing?.names?.[id] ?? "" })),
    headers: Object.entries(editing?.headers ?? {}).map(([name, value]) => ({ name, value })),
    key: "",
    // Headers are edited as rows, or as one JSON object that can be pasted in whole.
    json: undefined as string | undefined,
    pending: false,
  })

  const models = () => state.models.filter((model) => model.id.trim())

  const rows = () => state.headers.filter((header) => header.name.trim()).map((header) => [header.name.trim(), header.value.trim()] as const)

  /** The headers in the JSON box as rows, or undefined (after telling the user) when it is not an object of text. */
  const fromJSON = () => {
    const parsed = (() => {
      try {
        return state.json?.trim() ? JSON.parse(state.json) : {}
      } catch {
        return undefined
      }
    })()
    // A header is text on the wire, so a value that is itself JSON (an object, a number) is sent as its JSON text.
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed))
      return Object.entries<unknown>(parsed).map(([name, value]) => ({
        name,
        value: typeof value === "string" ? value : JSON.stringify(value),
      }))
    showToast({ title: language.t("common.requestFailed"), description: language.t("settings.providers.personal.headers.invalid") })
    return undefined
  }

  const showJSON = (json: boolean) => {
    if (json) return setState("json", JSON.stringify(Object.fromEntries(rows()), null, 2))
    const parsed = fromJSON()
    if (!parsed) return
    setState({ headers: parsed, json: undefined })
  }

  const save = async () => {
    const headers = state.json === undefined ? rows() : fromJSON()?.map((header) => [header.name, header.value] as const)
    if (!headers) return
    setState("pending", true)
    await sdk.api.credential.customProvider
      .save({
        providerID: state.id.trim(),
        name: state.name.trim(),
        baseURL: state.baseURL.trim(),
        models: models().map((model) => model.id.trim()),
        names: Object.fromEntries(models().flatMap((model) => (model.name.trim() ? [[model.id.trim(), model.name.trim()] as const] : []))),
        headers: Object.fromEntries(headers),
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
          <div class="personal-provider-row">
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
          </div>
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
            {language.t(editing ? "settings.providers.personal.key.replace" : "settings.providers.personal.key")}
            <TextInput
              type="password"
              autocomplete="new-password"
              value={state.key}
              onInput={(event) => setState("key", event.currentTarget.value)}
            />
          </label>
          <fieldset class="personal-provider-list">
            <legend>{language.t("settings.providers.personal.models.title")}</legend>
            <div class="personal-provider-columns">
              <span>{language.t("settings.providers.personal.models.id")}</span>
              <span>{language.t("settings.providers.personal.models.name")}</span>
            </div>
            <For each={state.models}>
              {(model, index) => (
                <div class="personal-provider-item">
                  <TextInput
                    autocomplete="off"
                    placeholder="gpt-4o"
                    aria-label={language.t("settings.providers.personal.models.id")}
                    spellcheck={false}
                    value={model.id}
                    onInput={(event) => setState("models", index(), "id", event.currentTarget.value)}
                  />
                  <TextInput
                    autocomplete="off"
                    aria-label={language.t("settings.providers.personal.models.name")}
                    value={model.name}
                    onInput={(event) => setState("models", index(), "name", event.currentTarget.value)}
                  />
                  <IconButton
                    type="button"
                    variant="ghost-muted"
                    icon={<Icon name="trash" />}
                    aria-label={language.t("settings.providers.personal.models.remove")}
                    disabled={state.models.length === 1}
                    onClick={() => setState("models", (all) => all.filter((_, at) => at !== index()))}
                  />
                </div>
              )}
            </For>
            <Button type="button" variant="ghost" icon="plus" onClick={() => setState("models", (all) => [...all, { id: "", name: "" }])}>
              {language.t("settings.providers.personal.models.add")}
            </Button>
          </fieldset>
          <details open={state.headers.length > 0}>
            <summary>{language.t("settings.providers.personal.headers")}</summary>
            <fieldset class="personal-provider-list">
              <div class="personal-provider-modes" role="group">
                <Button type="button" size="small" variant={state.json === undefined ? "neutral" : "ghost"} onClick={() => state.json !== undefined && showJSON(false)}>
                  {language.t("settings.providers.personal.headers.table")}
                </Button>
                <Button type="button" size="small" variant={state.json === undefined ? "ghost" : "neutral"} onClick={() => state.json === undefined && showJSON(true)}>
                  {language.t("settings.providers.personal.headers.json")}
                </Button>
              </div>
              <Show
                when={state.json === undefined}
                fallback={
                  <textarea
                    class="personal-provider-json"
                    rows={6}
                    placeholder={'{\n  "X-Employee": "{{employeeID}}"\n}'}
                    spellcheck={false}
                    aria-label={language.t("settings.providers.personal.headers")}
                    value={state.json}
                    onInput={(event) => setState("json", event.currentTarget.value)}
                  />
                }
              >
                <Show when={state.headers.length > 0}>
                  <div class="personal-provider-columns">
                    <span>{language.t("settings.providers.personal.headers.name")}</span>
                    <span>{language.t("settings.providers.personal.headers.value")}</span>
                  </div>
                </Show>
                <For each={state.headers}>
                  {(header, index) => (
                    <div class="personal-provider-item">
                      <TextInput
                        autocomplete="off"
                        placeholder="X-Team"
                        aria-label={language.t("settings.providers.personal.headers.name")}
                        spellcheck={false}
                        value={header.name}
                        onInput={(event) => setState("headers", index(), "name", event.currentTarget.value)}
                      />
                      <TextInput
                        autocomplete="off"
                        placeholder="{{organization}}"
                        aria-label={language.t("settings.providers.personal.headers.value")}
                        spellcheck={false}
                        value={header.value}
                        onInput={(event) => setState("headers", index(), "value", event.currentTarget.value)}
                      />
                      <IconButton
                        type="button"
                        variant="ghost-muted"
                        icon={<Icon name="trash" />}
                        aria-label={language.t("settings.providers.personal.headers.remove")}
                        onClick={() => setState("headers", (all) => all.filter((_, at) => at !== index()))}
                      />
                    </div>
                  )}
                </For>
                <Button type="button" variant="ghost" icon="plus" onClick={() => setState("headers", (all) => [...all, { name: "", value: "" }])}>
                  {language.t("settings.providers.personal.headers.add")}
                </Button>
              </Show>
              <span class="personal-provider-hint">
                {language.t("settings.providers.personal.headers.note", { variables: "{{employeeID}} {{name}} {{organization}} {{organizationID}}" })}
              </span>
            </fieldset>
          </details>
          <div class="personal-provider-actions">
            <Button type="button" variant="ghost" onClick={() => dialog.close()}>
              {language.t("common.cancel")}
            </Button>
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
