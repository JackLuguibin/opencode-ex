import { createResource, createSignal, For, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { Button } from "@opencode/ui/button"
import { useDialog } from "@opencode/ui/context/dialog"
import { Dialog, DialogBody, DialogHeader, DialogTitleGroup } from "@opencode/ui/dialog"
import { Icon } from "@opencode/ui/icon"
import { Switch } from "@opencode/ui/switch"
import { TextInput } from "@opencode/ui/text-input"
import { useLanguage } from "@/runtime/i18n/language"
import { showToast } from "@/shell/notifications/toast"
import { SettingsList } from "@/settings/list"
import { accountFetch, AccountError, type AccountOrganization, type AccountPackage } from "./api"
import { useAccountOptional } from "./gate"
import { OrganizationPicker } from "./organization-picker"
import "./global-packages.css"

const base64 = (bytes: Uint8Array) => {
  let binary = ""
  for (let index = 0; index < bytes.length; index += 0x8000)
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000))
  return btoa(binary)
}

/**
 * Skill or plugin packages shared by every organization. Platform admins upload and delete them; admins of the
 * current organization switch them on or off for it; everyone else only sees the list.
 */
export function GlobalPackages(props: { kind: AccountPackage["kind"] }) {
  const account = useAccountOptional()
  const language = useLanguage()
  const dialog = useDialog()
  const [state, setState] = createStore({
    name: "",
    trusted: false,
    deleting: "",
    pending: false,
    organizations: [] as string[],
    editing: "",
    draft: [] as string[],
  })
  const [file, setFile] = createSignal<File>()
  const [over, setOver] = createSignal(false)
  const [packages, { refetch }] = createResource(
    () => account?.session.employeeID,
    () =>
      accountFetch<AccountPackage[]>({
        url: account!.server.http.url,
        password: account!.server.http.password,
        path: "/api/package",
      }).catch(() => [] as AccountPackage[]),
    { initialValue: [] },
  )
  // Only platform admins choose which organizations a package is open to.
  const [organizations] = createResource(
    () => (account?.session.admin ? account.session.employeeID : undefined),
    () =>
      accountFetch<AccountOrganization[]>({
        url: account!.server.http.url,
        password: account!.server.http.password,
        path: "/api/organization",
      }).catch(() => [] as AccountOrganization[]),
    { initialValue: [] },
  )
  const nameOf = (id: string) => (organizations.latest ?? []).find((item) => item.id === id)?.name ?? id
  const items = () => (packages.latest ?? []).filter((item) => item.kind === props.kind)

  const fail = (title: string, error: unknown) =>
    showToast({ variant: "error", title, description: error instanceof AccountError ? error.message : undefined })

  const call = async (input: { path: string; method?: string; body?: unknown }, failure: string) => {
    setState("pending", true)
    try {
      await accountFetch({
        url: account!.server.http.url,
        password: account!.server.http.password,
        ...input,
      })
      await refetch()
      return true
    } catch (error) {
      fail(failure, error)
      return false
    } finally {
      setState("pending", false)
    }
  }

  const openUpload = () => {
    setFile(undefined)
    setState({ name: "", trusted: false, organizations: [] })
    void dialog.show(() => (
      <Dialog fit>
        <DialogHeader>
          <DialogTitleGroup title={language.t(`account.packages.upload.${props.kind}`)} />
        </DialogHeader>
        <DialogBody>
          <form
            data-component="package-upload"
            onSubmit={(event) => {
              event.preventDefault()
              void upload()
            }}
          >
            <label
              class="package-drop"
              data-over={over() ? "" : undefined}
              data-filled={file() ? "" : undefined}
              onDragOver={(event) => {
                event.preventDefault()
                setOver(true)
              }}
              onDragLeave={() => setOver(false)}
              onDrop={(event) => {
                event.preventDefault()
                setOver(false)
                choose(event.dataTransfer?.files[0])
              }}
            >
              <input
                type="file"
                accept=".zip,application/zip"
                onChange={(event) => choose(event.currentTarget.files?.[0])}
              />
              <Icon name="folder" size="large" />
              <Show
                when={file()}
                fallback={
                  <>
                    <span class="package-drop-title">{language.t("account.packages.drop.title")}</span>
                    <span class="package-drop-hint">{language.t("account.packages.drop.hint")}</span>
                  </>
                }
              >
                {(selected) => (
                  <>
                    <span class="package-drop-title">{selected().name}</span>
                    <span class="package-drop-hint">
                      {language.t("account.packages.drop.change", { size: `${Math.max(1, Math.round(selected().size / 1024))} KB` })}
                    </span>
                  </>
                )}
              </Show>
            </label>
            <label class="package-field">
              {language.t("account.packages.name")}
              <TextInput
                autocomplete="off"
                value={state.name}
                onInput={(event) => setState("name", event.currentTarget.value)}
              />
            </label>
            <div class="package-field">
              {language.t("account.packages.organizations")}
              {organizationPicker(
                () => state.organizations,
                (next) => setState("organizations", next),
              )}
            </div>
            <Show when={props.kind === "plugin"}>
              <label class="package-trust">
                <input
                  type="checkbox"
                  checked={state.trusted}
                  onChange={(event) => setState("trusted", event.currentTarget.checked)}
                />
                {language.t("account.packages.trust")}
              </label>
            </Show>
            <div class="package-actions">
              <Button type="button" variant="ghost" onClick={() => dialog.close()}>
                {language.t("account.admin.cancel")}
              </Button>
              <Button type="submit" variant="contrast" icon="plus" disabled={state.pending}>
                {language.t("account.packages.upload")}
              </Button>
            </div>
          </form>
        </DialogBody>
      </Dialog>
    ))
  }

  const choose = (selected: File | undefined) => {
    setFile(selected)
    if (selected && !state.name) setState("name", selected.name.replace(/\.zip$/i, "").toLowerCase().replace(/[^a-z0-9._-]+/g, "-"))
  }

  const upload = async () => {
    const selected = file()
    // Say what is missing instead of leaving a disabled button unexplained.
    const missing = !selected
      ? "account.packages.missing.file"
      : !state.name.trim()
        ? "account.packages.missing.name"
        : state.organizations.length === 0
          ? "account.packages.missing.organizations"
          : props.kind === "plugin" && !state.trusted
            ? "account.packages.missing.trust"
            : undefined
    if (missing || !selected) {
      if (missing) showToast({ variant: "error", title: language.t(missing) })
      return
    }
    const archive = base64(new Uint8Array(await selected.arrayBuffer()))
    const ok = await call(
      { path: "/api/package", body: { kind: props.kind, name: state.name.trim(), archive, organizations: state.organizations } },
      language.t("account.packages.uploadFailed"),
    )
    if (!ok) return
    dialog.close()
  }

  const organizationPicker = (selected: () => string[], change: (next: string[]) => void) => (
    <OrganizationPicker organizations={organizations.latest ?? []} selected={selected()} onChange={change} />
  )

  return (
    <Show when={account}>
      {(current) => (
        <div class="settings-section" data-component="global-packages">
          <div class="flex items-start justify-between gap-4">
            <div class="flex flex-col gap-1">
              <span class="settings-extension-heading text-13-medium">{language.t("account.packages.title")}</span>
              <span class="text-13-regular text-v2-text-text-muted">
                {language.t(`account.packages.description.${props.kind}`)}
              </span>
            </div>
            <Show when={current().session.admin}>
              <Button variant="contrast" icon="plus" class="shrink-0" onClick={openUpload}>
                {language.t("account.packages.upload")}
              </Button>
            </Show>
          </div>
          <SettingsList variant="catalog">
            <Show
              when={items().length > 0}
              fallback={<div class="settings-extension-row text-v2-text-text-muted">{language.t("account.packages.empty")}</div>}
            >
              <For each={items()}>
                {(item) => (
                  <div class="settings-extension-row flex-wrap">
                    <div class="settings-extension-lead">
                      <Icon name="post-skill" class="text-v2-icon-icon-muted shrink-0" />
                      <div class="flex min-w-0 flex-col">
                        <span class="settings-extension-name truncate">{item.name}</span>
                        <span class="truncate text-11-regular text-v2-text-text-muted">
                          {item.description || language.t("account.packages.uploadedBy", { employeeID: item.uploadedBy })}
                        </span>
                        <Show when={current().session.admin}>
                          <span class="truncate text-11-regular text-v2-text-text-muted">
                            {language.t("account.packages.organizations")}:{" "}
                            {item.organizations.length > 0
                              ? item.organizations.map(nameOf).join(", ")
                              : language.t("account.packages.noOrganizations")}
                          </span>
                        </Show>
                      </div>
                    </div>
                    <div class="flex shrink-0 items-center gap-2">
                      <Show when={current().session.organizationAdmin && current().session.organizationID}>
                        <Switch
                          checked={item.enabled}
                          disabled={state.pending}
                          description={item.name}
                          class="[&_[data-slot=switch-description]]:sr-only"
                          onChange={(enabled) =>
                            void call(
                              {
                                path: `/api/organization/${current().session.organizationID}/package/${item.kind}/${encodeURIComponent(item.name)}`,
                                method: "PUT",
                                body: { enabled },
                              },
                              language.t("account.packages.updateFailed"),
                            )
                          }
                        />
                      </Show>
                      <Show when={current().session.admin}>
                        <Button
                          variant="ghost"
                          onClick={() =>
                            state.editing === item.name
                              ? setState("editing", "")
                              : setState({ editing: item.name, draft: [...item.organizations] })
                          }
                        >
                          {language.t("account.packages.scope")}
                        </Button>
                        <Show
                          when={state.deleting === item.name}
                          fallback={
                            <Button variant="ghost" onClick={() => setState("deleting", item.name)}>
                              {language.t("account.packages.delete")}
                            </Button>
                          }
                        >
                          <Button
                            variant="ghost-danger"
                            disabled={state.pending}
                            onClick={() =>
                              void call(
                                { path: `/api/package/${item.kind}/${encodeURIComponent(item.name)}`, method: "DELETE" },
                                language.t("account.packages.updateFailed"),
                              ).then(() => setState("deleting", ""))
                            }
                          >
                            {language.t("account.admin.confirmRemove")}
                          </Button>
                          <Button variant="ghost" onClick={() => setState("deleting", "")}>
                            {language.t("account.admin.cancel")}
                          </Button>
                        </Show>
                      </Show>
                    </div>
                    <Show when={current().session.admin && state.editing === item.name}>
                      <div class="flex w-full flex-wrap items-center gap-3 pt-2">
                        {organizationPicker(
                          () => state.draft,
                          (next) => setState("draft", next),
                        )}
                        <Button
                          variant="contrast"
                          disabled={state.pending}
                          onClick={() =>
                            void call(
                              {
                                path: `/api/package/${item.kind}/${encodeURIComponent(item.name)}/organizations`,
                                method: "PUT",
                                body: { organizations: state.draft },
                              },
                              language.t("account.packages.updateFailed"),
                            ).then((ok) => ok && setState("editing", ""))}
                        >
                          {language.t("account.packages.save")}
                        </Button>
                      </div>
                    </Show>
                  </div>
                )}
              </For>
            </Show>
          </SettingsList>
        </div>
      )}
    </Show>
  )
}
