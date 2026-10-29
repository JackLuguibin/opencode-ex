import { createEffect, createMemo, createSignal, For, onCleanup, Show } from "solid-js"
import { Combobox } from "@kobalte/core/combobox"
import { createStore } from "solid-js/store"
import { Button } from "@opencode/ui/button"
import { useDialog } from "@opencode/ui/context/dialog"
import { Dialog, DialogBody, DialogHeader, DialogTitleGroup } from "@opencode/ui/dialog"
import { Icon } from "@opencode/ui/icon"
import { Loader } from "@opencode/ui/loader"
import { TextInput } from "@opencode/ui/text-input"
import { Wordmark } from "@opencode/ui/wordmark"
import { useLanguage } from "@/runtime/i18n/language"
import type { ServerConnection } from "@/runtime/server/registry"
import { popularProviders } from "@/providers/catalog/order"
import { formatHeaders, formatModels, parseHeaders, parseModels } from "@/settings/providers/personal-provider"
import { pageLabels } from "@/settings/pages"
import {
  accountFetch,
  AccountError,
  type AccountCredential,
  type AccountCustomProvider,
  type AccountOrganization,
  type AccountSession,
  type AccountUser,
} from "./api"
import "./admin.css"

type OrganizationTab = "pages" | "credentials" | "providers" | "members"

const organizationTabs = [
  { id: "pages", label: "account.admin.pages" },
  { id: "providers", label: "account.admin.custom" },
  { id: "credentials", label: "account.admin.credentials" },
  { id: "members", label: "account.admin.members" },
] as const satisfies ReadonlyArray<{ id: OrganizationTab; label: string }>

export function AdminConsole(props: {
  server: ServerConnection.Http
  session: AccountSession
  onSession: (session: AccountSession) => void
  onLogout: () => void
  onClose?: () => void
}) {
  const language = useLanguage()
  const dialog = useDialog()
  const [selected, setSelected] = createSignal<string>()
  const [loaded, setLoaded] = createSignal(false)
  const [view, setView] = createSignal<"organizations" | "users">("organizations")
  const [state, setState] = createStore({
    search: "",
    name: "",
    member: "",
    memberFilter: "",
    userSearch: "",
    tab: "pages" as OrganizationTab,
    renaming: false,
    rename: "",
    resetting: "",
    newPassword: "",
    credentials: [] as AccountCredential[],
    credentialsLoaded: false,
    customProviders: [] as AccountCustomProvider[],
    newProvider: { id: "", name: "", baseURL: "", models: "", headers: "", key: "" },
    newCredential: { integrationID: "", key: "", label: "", custom: false },
    creating: { employeeID: "", password: "", organizationID: "", admin: false },
    users: [] as AccountUser[],
    usersLoaded: false,
    organizations: [] as AccountOrganization[],
    error: "",
    status: "",
    pending: false,
  })

  let statusTimer: ReturnType<typeof setTimeout> | undefined
  onCleanup(() => clearTimeout(statusTimer))
  const announce = (message: string) => {
    clearTimeout(statusTimer)
    setState("status", message)
    statusTimer = setTimeout(() => setState("status", ""), 4000)
  }

  const fail = (error: unknown) => {
    if (error instanceof AccountError && error.status === 403) return language.t("account.error.forbidden")
    if (error instanceof AccountError && error.message.toLowerCase().includes("register this"))
      return language.t("account.error.missing")
    if (error instanceof AccountError && (error.status === 400 || error.status === 401))
      return language.t("account.error.invalid")
    return language.t("account.error.connection")
  }

  const password = () => props.server.http.password
  // Organization admins manage their own organization; the user list, new organizations and roles are platform-wide.
  const platform = () => props.session.admin
  const api = (path: string) => `/api/organization/${encodeURIComponent(path)}`

  const loadOrganizations = async (current: string) => {
    const organizations = await accountFetch<AccountOrganization[]>({
      url: props.server.http.url,
      password: current,
      path: "/api/organization",
    })
    setState("organizations", organizations)
    setLoaded(true)
    const chosen = selected()
    if (chosen && organizations.some((item) => item.id === chosen)) return
    setSelected(organizations[0]?.id)
  }

  const refreshSession = async (current: string) => {
    const session = await accountFetch<AccountSession>({
      url: props.server.http.url,
      password: current,
      path: "/api/auth/session",
    })
    props.onSession(session)
  }

  /** Runs one admin action with the shared pending, error and success handling; true when it succeeded. */
  const run = async (task: (current: string) => Promise<void>, success?: string) => {
    const current = password()
    if (!current || state.pending) return false
    setState({
      error: "",
      status: "",
      pending: true,
    })
    try {
      await task(current)
      if (success) announce(success)
      return true
    } catch (error) {
      setState("error", fail(error))
      return false
    } finally {
      setState("pending", false)
    }
  }

  const reload = async (current: string) => {
    await loadOrganizations(current)
    await refreshSession(current)
  }

  const createOrganization = async () => {
    const name = state.name.trim()
    if (!name) return
    const done = await run(
      async (current) => {
        const created = await accountFetch<AccountOrganization>({
          url: props.server.http.url,
          password: current,
          path: "/api/organization",
          body: { name },
        })
        setSelected(created.id)
        await reload(current)
      },
      language.t("account.admin.status.created", { name }),
    )
    if (done) dialog.close()
  }

  const renameOrganization = async () => {
    const organization = selectedOrganization()
    const name = state.rename.trim()
    if (!organization || !name) return
    if (name === organization.name) return setState("renaming", false)
    const done = await run(async (current) => {
      await accountFetch({
        url: props.server.http.url,
        password: current,
        path: api(organization.id),
        method: "PATCH",
        body: { name },
      })
      await reload(current)
    }, language.t("account.admin.status.renamed"))
    if (done) setState("renaming", false)
  }

  const deleteOrganization = async () => {
    const organization = selectedOrganization()
    if (!organization) return
    await run(async (current) => {
      await accountFetch({
        url: props.server.http.url,
        password: current,
        path: api(organization.id),
        method: "DELETE",
      })
      await reload(current)
    }, language.t("account.admin.status.organizationDeleted", { name: organization.name }))
  }

  const addMember = async () => {
    const organization = selectedOrganization()
    const employeeID = state.member.trim()
    if (!organization || !canAdd()) return
    const done = await run(
      async (current) => {
        await accountFetch({
          url: props.server.http.url,
          password: current,
          path: `${api(organization.id)}/member`,
          body: { employeeID },
        })
        await reload(current)
      },
      language.t("account.admin.status.added", { employeeID }),
    )
    if (done) dialog.close()
  }

  const removeMember = async (employeeID: string) => {
    const organization = selectedOrganization()
    if (!organization) return
    await run(
      async (current) => {
        await accountFetch({
          url: props.server.http.url,
          password: current,
          path: `${api(organization.id)}/member/${encodeURIComponent(employeeID)}`,
          method: "DELETE",
        })
        await reload(current)
      },
      language.t("account.admin.status.removed", { employeeID }),
    )
  }

  const setRole = async (employeeID: string, role: "admin" | "member") => {
    const organization = selectedOrganization()
    if (!organization) return
    await run(
      async (current) => {
        await accountFetch({
          url: props.server.http.url,
          password: current,
          path: `${api(organization.id)}/member/${encodeURIComponent(employeeID)}/role`,
          method: "PUT",
          body: { role },
        })
        await reload(current)
      },
      language.t("account.admin.status.roleChanged", { employeeID }),
    )
  }

  const setPage = async (page: keyof typeof pageLabels, enabled: boolean) => {
    const organization = selectedOrganization()
    if (!organization) return
    const pages = Object.keys(pageLabels).filter((item) =>
      item === page ? enabled : organization.settingsPages.includes(item),
    )
    // Members need at least one page to land on.
    if (pages.length === 0) return
    await run(async (current) => {
      const updated = await accountFetch<AccountOrganization>({
        url: props.server.http.url,
        password: current,
        path: `${api(organization.id)}/settings`,
        method: "PUT",
        body: { pages },
      })
      setState("organizations", (item) => item.id === updated.id, updated)
      await refreshSession(current)
    }, language.t("account.admin.status.pages"))
  }

  const credentialPath = (organizationID: string, credentialID?: string) =>
    `${api(organizationID)}/credential${credentialID ? `/${encodeURIComponent(credentialID)}` : ""}`

  const loadCredentials = async (current: string, organizationID: string) => {
    const credentials = await accountFetch<AccountCredential[]>({
      url: props.server.http.url,
      password: current,
      path: credentialPath(organizationID),
    })
    // A slower answer for an organization that is no longer selected must not replace the current list.
    if (selected() === organizationID) setState({ credentials, credentialsLoaded: true })
  }

  const loadCustomProviders = async (current: string, organizationID: string) => {
    const customProviders = await accountFetch<AccountCustomProvider[]>({
      url: props.server.http.url,
      password: current,
      path: `${api(organizationID)}/provider`,
    })
    if (selected() === organizationID) setState("customProviders", customProviders)
  }

  const saveCustomProvider = async () => {
    const organization = selectedOrganization()
    const draft = state.newProvider
    const { models, names } = parseModels(draft.models)
    if (!organization || !draft.id.trim() || !draft.name.trim() || !draft.baseURL.trim() || models.length === 0) return
    const done = await run(async (current) => {
      await accountFetch({
        url: props.server.http.url,
        password: current,
        path: `${api(organization.id)}/provider/${encodeURIComponent(draft.id.trim())}`,
        method: "PUT",
        body: {
          name: draft.name.trim(),
          baseURL: draft.baseURL.trim(),
          models,
          names,
          headers: parseHeaders(draft.headers),
          ...(draft.key.trim() ? { key: draft.key.trim() } : {}),
        },
      })
      await Promise.all([loadCustomProviders(current, organization.id), loadCredentials(current, organization.id)])
    }, language.t("account.admin.status.customSaved", { name: draft.name.trim() }))
    if (done) dialog.close()
  }

  const removeCustomProvider = async (provider: AccountCustomProvider) => {
    const organization = selectedOrganization()
    if (!organization) return
    await run(async (current) => {
      await accountFetch({
        url: props.server.http.url,
        password: current,
        path: `${api(organization.id)}/provider/${encodeURIComponent(provider.id)}`,
        method: "DELETE",
      })
      await Promise.all([loadCustomProviders(current, organization.id), loadCredentials(current, organization.id)])
    }, language.t("account.admin.status.customRemoved", { name: provider.name }))
  }

  const addCredential = async () => {
    const organization = selectedOrganization()
    const { integrationID, key, label } = state.newCredential
    if (!organization || !integrationID.trim() || !key.trim()) return
    const done = await run(async (current) => {
      await accountFetch({
        url: props.server.http.url,
        password: current,
        path: credentialPath(organization.id),
        body: { integrationID: integrationID.trim(), key: key.trim(), ...(label.trim() ? { label: label.trim() } : {}) },
      })
      await loadCredentials(current, organization.id)
    }, language.t("account.admin.status.credentialAdded", { provider: integrationID.trim() }))
    if (done) dialog.close()
  }

  const selectCredential = async (credential: AccountCredential) => {
    const organization = selectedOrganization()
    if (!organization) return
    await run(async (current) => {
      await accountFetch({
        url: props.server.http.url,
        password: current,
        path: `${credentialPath(organization.id, credential.id)}/activate`,
        method: "POST",
        body: {},
      })
      await loadCredentials(current, organization.id)
    }, language.t("account.admin.status.credentialSelected", { provider: credential.integrationID, label: credential.label }))
  }

  const removeCredential = async (credential: AccountCredential) => {
    const organization = selectedOrganization()
    if (!organization) return
    await run(async (current) => {
      await accountFetch({
        url: props.server.http.url,
        password: current,
        path: credentialPath(organization.id, credential.id),
        method: "DELETE",
      })
      await loadCredentials(current, organization.id)
    }, language.t("account.admin.status.credentialRemoved", { provider: credential.integrationID }))
  }

  const createUser = async () => {
    const { employeeID, password: initial, organizationID, admin } = state.creating
    const id = employeeID.trim()
    if (!id || initial.length < 8) return
    const done = await run(
      async (current) => {
        await accountFetch({
          url: props.server.http.url,
          password: current,
          path: "/api/auth/users",
          body: { employeeID: id, password: initial, admin, ...(organizationID ? { organizationID } : {}) },
        })
        await Promise.all([loadUsers(current), loadOrganizations(current)])
      },
      language.t("account.admin.status.userCreated", { employeeID: id }),
    )
    if (!done) return
    setState("creating", { employeeID: "", password: "", organizationID: "", admin: false })
    dialog.close()
  }

  const openCreateUser = () => {
    setState("creating", { employeeID: "", password: "", organizationID: "", admin: false })
    void dialog.show(() => (
      <Dialog fit>
        <DialogHeader>
          <DialogTitleGroup title={language.t("account.admin.users.create")} />
        </DialogHeader>
        <DialogBody>
          <form
            data-component="admin-dialog-form"
              data-scrollable
            onSubmit={(event) => {
              event.preventDefault()
              void createUser()
            }}
          >
            <label>
              {language.t("account.employeeID")}
              <TextInput
                required
                autocomplete="off"
                value={state.creating.employeeID}
                onInput={(event) => setState("creating", "employeeID", event.currentTarget.value)}
              />
            </label>
            <label>
              {language.t("account.admin.users.password")}
              <TextInput
                required
                type="password"
                minLength={8}
                autocomplete="new-password"
                value={state.creating.password}
                onInput={(event) => setState("creating", "password", event.currentTarget.value)}
              />
            </label>
            <label>
              {language.t("account.admin.users.organization")}
              <select
                value={state.creating.organizationID}
                onChange={(event) => setState("creating", "organizationID", event.currentTarget.value)}
              >
                <option value="">{language.t("account.admin.users.noneOrganization")}</option>
                <For each={state.organizations}>
                  {(organization) => <option value={organization.id}>{organization.name}</option>}
                </For>
              </select>
            </label>
            <div class="admin-create-actions">
              <label class="admin-check">
                <input
                  type="checkbox"
                  checked={state.creating.admin}
                  onChange={(event) => setState("creating", "admin", event.currentTarget.checked)}
                />
                {language.t("account.admin.users.makeAdmin")}
              </label>
              <Button
                type="submit"
                variant="contrast"
                icon="plus"
                disabled={
                  state.pending || !state.creating.employeeID.trim() || state.creating.password.length < 8
                }
              >
                {language.t("account.admin.users.create")}
              </Button>
            </div>
          </form>
        </DialogBody>
      </Dialog>
    ))
  }

  const emptyProvider = { id: "", name: "", baseURL: "", models: "", headers: "", key: "" }
  const emptyCredential = { integrationID: "", key: "", label: "", custom: false }

  const formError = () => (
    <Show when={state.error}>
      <p class="admin-dialog-error" role="alert">
        {state.error}
      </p>
    </Show>
  )

  /** Asks before a removal; the action runs under the console's shared pending and error handling. */
  const confirmRemoval = (message: string, action: () => Promise<unknown>) =>
    void dialog.show(() => (
      <Dialog fit>
        <DialogHeader>
          <DialogTitleGroup title={language.t("account.admin.confirm.title")} />
        </DialogHeader>
        <DialogBody>
          <div data-component="admin-dialog-form" data-confirm>
            <p>{message}</p>
            <div class="admin-dialog-actions">
              <Button type="button" variant="ghost" onClick={() => dialog.close()}>
                {language.t("account.admin.cancel")}
              </Button>
              <Button
                type="button"
                variant="ghost-danger"
                autofocus
                disabled={state.pending}
                onClick={() => void action().then(() => dialog.close())}
              >
                {language.t("account.admin.confirmRemove")}
              </Button>
            </div>
          </div>
        </DialogBody>
      </Dialog>
    ))

  const openCreateOrganization = () => {
    setState({ error: "", name: "" })
    void dialog.show(
      () => (
        <Dialog fit>
          <DialogHeader>
            <DialogTitleGroup title={language.t("account.admin.create")} />
          </DialogHeader>
          <DialogBody>
            <form
              data-component="admin-dialog-form"
              data-scrollable
              data-single
              onSubmit={(event) => {
                event.preventDefault()
                void createOrganization()
              }}
            >
              <label>
                {language.t("account.admin.name")}
                <TextInput
                  required
                  autofocus
                  maxLength={80}
                  value={state.name}
                  onInput={(event) => setState("name", event.currentTarget.value)}
                />
              </label>
              {formError()}
              <div class="admin-dialog-actions">
                <Button type="button" variant="ghost" onClick={() => dialog.close()}>
                  {language.t("account.admin.cancel")}
                </Button>
                <Button type="submit" variant="contrast" disabled={state.pending || !state.name.trim()}>
                  {language.t("account.admin.create")}
                </Button>
              </div>
            </form>
          </DialogBody>
        </Dialog>
      ),
      () => setState("name", ""),
    )
  }

  const openMember = () => {
    setState({ error: "", member: "" })
    void dialog.show(
      () => (
        <Dialog fit>
          <DialogHeader>
            <DialogTitleGroup
              title={language.t("account.admin.addMember")}
              description={language.t("account.admin.addMember.description")}
            />
          </DialogHeader>
          <DialogBody>
            <form
              data-component="admin-dialog-form"
              data-scrollable
              data-single
              onSubmit={(event) => {
                event.preventDefault()
                void addMember()
              }}
            >
              <Show
                when={platform()}
                fallback={
                  <label>
                    {language.t("account.employeeID")}
                    <TextInput
                      class="admin-user-picker"
                      autofocus
                      autocomplete="off"
                      maxLength={64}
                      placeholder={language.t("account.admin.typeEmployeeID")}
                      disabled={state.pending}
                      value={state.member}
                      onInput={(event) => setState("member", event.currentTarget.value)}
                    />
                  </label>
                }
              >
                <Combobox<string>
                  class="admin-user-picker"
                  options={availableUsers()}
                  value={availableUsers().includes(state.member) ? state.member : null}
                  onChange={(employeeID) => setState("member", employeeID ?? "")}
                  placeholder={language.t("account.admin.selectUser")}
                  disabled={state.pending || !state.usersLoaded}
                  defaultFilter="contains"
                  triggerMode="focus"
                  sameWidth
                  allowsEmptyCollection
                  itemComponent={(item) => (
                    <Combobox.Item item={item.item} class="admin-user-option">
                      <Combobox.ItemLabel>{item.item.rawValue}</Combobox.ItemLabel>
                    </Combobox.Item>
                  )}
                >
                  <Combobox.Label>{language.t("account.employeeID")}</Combobox.Label>
                  <Combobox.Control class="admin-user-control">
                    <Combobox.Input autocomplete="off" />
                    <Combobox.Trigger aria-label={language.t("account.admin.selectUser")}>
                      <Icon name="chevron-down" />
                    </Combobox.Trigger>
                  </Combobox.Control>
                  <Combobox.Portal>
                    <Combobox.Content data-component="admin-user-options">
                      <Combobox.Listbox data-scrollable />
                      <Show when={availableUsers().length === 0}>
                        <p>{language.t("account.admin.noUsers")}</p>
                      </Show>
                    </Combobox.Content>
                  </Combobox.Portal>
                </Combobox>
              </Show>
              {formError()}
              <div class="admin-dialog-actions">
                <Button type="button" variant="ghost" onClick={() => dialog.close()}>
                  {language.t("account.admin.cancel")}
                </Button>
                <Button type="submit" variant="contrast" icon="plus" disabled={state.pending || !canAdd()}>
                  {language.t("account.admin.add")}
                </Button>
              </div>
            </form>
          </DialogBody>
        </Dialog>
      ),
      () => setState("member", ""),
    )
  }

  const openCredential = () => {
    setState({ error: "", newCredential: { ...emptyCredential } })
    void dialog.show(
      () => (
        <Dialog fit>
          <DialogHeader>
            <DialogTitleGroup title={language.t("account.admin.credentials.form")} />
          </DialogHeader>
          <DialogBody>
            <form
              data-component="admin-dialog-form"
              data-scrollable
              onSubmit={(event) => {
                event.preventDefault()
                void addCredential()
              }}
            >
              <label data-wide={state.newCredential.custom ? undefined : ""}>
                {language.t("account.admin.credentials.provider")}
                <select
                  required
                  value={state.newCredential.custom ? "other" : state.newCredential.integrationID}
                  onChange={(event) => {
                    const value = event.currentTarget.value

                    if (value === "other") setState("newCredential", { custom: true, integrationID: "" })
                    else setState("newCredential", { custom: false, integrationID: value })
                  }}
                >
                  <option value="" disabled>
                    {language.t("account.admin.credentials.choose")}
                  </option>
                  <For each={popularProviders}>{(provider) => <option value={provider}>{provider}</option>}</For>
                  <option value="other">{language.t("account.admin.credentials.other")}</option>
                </select>
              </label>
              <Show when={state.newCredential.custom}>
                <label>
                  {language.t("account.admin.credentials.providerID")}
                  <TextInput
                    required
                    autofocus
                    autocomplete="off"
                    value={state.newCredential.integrationID}
                    onInput={(event) => setState("newCredential", "integrationID", event.currentTarget.value)}
                  />
                </label>
              </Show>
              <label data-wide>
                {language.t("account.admin.credentials.key")}
                <TextInput
                  required
                  type="password"
                  autocomplete="off"
                  value={state.newCredential.key}
                  onInput={(event) => setState("newCredential", "key", event.currentTarget.value)}
                />
              </label>
              <label data-wide>
                {language.t("account.admin.credentials.label")}
                <TextInput
                  autocomplete="off"
                  value={state.newCredential.label}
                  onInput={(event) => setState("newCredential", "label", event.currentTarget.value)}
                />
              </label>
              {formError()}
              <div class="admin-dialog-actions">
                <Button type="button" variant="ghost" onClick={() => dialog.close()}>
                  {language.t("account.admin.cancel")}
                </Button>
                <Button
                  type="submit"
                  variant="contrast"
                  icon="plus"
                  disabled={state.pending || !state.newCredential.integrationID.trim() || !state.newCredential.key.trim()}
                >
                  {language.t("account.admin.credentials.add")}
                </Button>
              </div>
            </form>
          </DialogBody>
        </Dialog>
      ),
      () => setState("newCredential", { ...emptyCredential }),
    )
  }

  const openProvider = (provider?: AccountCustomProvider) => {
    setState({
      error: "",
      newProvider: provider
        ? {
            id: provider.id,
            name: provider.name,
            baseURL: provider.baseURL,
            models: formatModels(provider.models, provider.names),
            headers: formatHeaders(provider.headers),
            key: "",
          }
        : { ...emptyProvider },
    })
    void dialog.show(
      () => (
        <Dialog fit>
          <DialogHeader>
            <DialogTitleGroup
              title={
                provider
                  ? language.t("account.admin.custom.form.edit", { name: provider.name })
                  : language.t("account.admin.custom.form.add")
              }
              description={language.t("account.admin.custom.description")}
            />
          </DialogHeader>
          <DialogBody>
            <form
              data-component="admin-dialog-form"
              data-scrollable
              onSubmit={(event) => {
                event.preventDefault()
                void saveCustomProvider()
              }}
            >
              <p data-section>{language.t("account.admin.custom.section.connection")}</p>
              <label>
                {language.t("account.admin.custom.id")}
                <TextInput
                  required
                  autocomplete="off"
                  placeholder="my-llm"
                  disabled={!!provider}
                  value={state.newProvider.id}
                  onInput={(event) => setState("newProvider", "id", event.currentTarget.value)}
                />
              </label>
              <label>
                {language.t("account.admin.custom.name")}
                <TextInput
                  required
                  autocomplete="off"
                  placeholder="My LLM"
                  value={state.newProvider.name}
                  onInput={(event) => setState("newProvider", "name", event.currentTarget.value)}
                />
              </label>
              <label data-wide>
                {language.t("account.admin.custom.baseURL")}
                <TextInput
                  required
                  type="url"
                  autocomplete="off"
                  placeholder="https://example.com/v1"
                  value={state.newProvider.baseURL}
                  onInput={(event) => setState("newProvider", "baseURL", event.currentTarget.value)}
                />
              </label>
              <label data-wide>
                {language.t("account.admin.custom.key")}
                <TextInput
                  type="password"
                  autocomplete="new-password"
                  value={state.newProvider.key}
                  onInput={(event) => setState("newProvider", "key", event.currentTarget.value)}
                />
              </label>
              <p data-section>{language.t("account.admin.custom.section.models")}</p>
              <label data-wide>
                {language.t("account.admin.custom.models")}
                <textarea
                  required
                  rows={4}
                  placeholder="model-a&#10;model-b | Display name"
                  spellcheck={false}
                  value={state.newProvider.models}
                  onInput={(event) => setState("newProvider", "models", event.currentTarget.value)}
                />
                <span class="admin-hint">{language.t("settings.providers.personal.models.hint")}</span>
              </label>
              <details data-advanced open={Object.keys(provider?.headers ?? {}).length > 0}>
                <summary data-section>{language.t("account.admin.custom.section.advanced")}</summary>
                <label>
                  {language.t("settings.providers.personal.headers")}
                  <textarea
                    rows={2}
                    placeholder="X-Team: my-team"
                    spellcheck={false}
                    value={state.newProvider.headers}
                    onInput={(event) => setState("newProvider", "headers", event.currentTarget.value)}
                  />
                  <span class="admin-hint">{language.t("settings.providers.personal.headers.hint")}</span>
                </label>
              </details>
              {formError()}
              <div class="admin-dialog-actions">
                <Button type="button" variant="ghost" onClick={() => dialog.close()}>
                  {language.t("account.admin.cancel")}
                </Button>
                <Button
                  type="submit"
                  variant="contrast"
                  icon="plus"
                  disabled={
                    state.pending ||
                    !state.newProvider.id.trim() ||
                    !state.newProvider.name.trim() ||
                    !state.newProvider.baseURL.trim() ||
                    !state.newProvider.models.trim()
                  }
                >
                  {language.t("account.admin.custom.add")}
                </Button>
              </div>
            </form>
          </DialogBody>
        </Dialog>
      ),
      () => setState("newProvider", { ...emptyProvider }),
    )
  }

  const deleteUser = async (employeeID: string) => {
    await run(
      async (current) => {
        await accountFetch({
          url: props.server.http.url,
          password: current,
          path: `/api/auth/users/${encodeURIComponent(employeeID)}`,
          method: "DELETE",
        })
        await Promise.all([loadUsers(current), loadOrganizations(current)])
      },
      language.t("account.admin.status.userDeleted", { employeeID }),
    )
  }

  const setAdmin = async (employeeID: string, admin: boolean) => {
    await run(
      async (current) => {
        await accountFetch({
          url: props.server.http.url,
          password: current,
          path: `/api/auth/users/${encodeURIComponent(employeeID)}/admin`,
          method: "PUT",
          body: { admin },
        })
        await loadUsers(current)
      },
      language.t("account.admin.status.roleChanged", { employeeID }),
    )
  }

  const resetPassword = async (employeeID: string) => {
    if (state.newPassword.length < 8) return
    const done = await run(
      async (current) => {
        await accountFetch({
          url: props.server.http.url,
          password: current,
          path: `/api/auth/users/${encodeURIComponent(employeeID)}/password`,
          body: { password: state.newPassword },
        })
      },
      language.t("account.admin.passwordReset", { employeeID }),
    )
    if (!done) return
    setState({ resetting: "", newPassword: "" })
    // Resetting your own password signs this session out too.
    if (employeeID === props.session.employeeID) props.onLogout()
  }

  const selectedOrganization = () => state.organizations.find((item) => item.id === selected())
  const availableUsers = () =>
    state.users
      .map((user) => user.employeeID)
      .filter((employeeID) => !selectedOrganization()?.members.includes(employeeID))
  const canAdd = () => {
    if (platform()) return availableUsers().includes(state.member)
    const employeeID = state.member.trim()
    return employeeID !== "" && !selectedOrganization()?.members.includes(employeeID)
  }
  const memberships = () => state.organizations.reduce((sum, item) => sum + item.members.length, 0)

  const loadUsers = (current: string) =>
    accountFetch<AccountUser[]>({ url: props.server.http.url, password: current, path: "/api/auth/users" }).then(
      (users) => setState({ users, usersLoaded: true }),
      (error) => setState("error", fail(error)),
    )

  createEffect(() => {
    const current = password()
    if (!current) return
    void loadOrganizations(current).catch((error) => setState("error", fail(error)))
    if (platform()) void loadUsers(current)
  })

  // The credentials shown always belong to the selected organization.
  createEffect(() => {
    const current = password()
    const organizationID = selected()
    setState({ credentials: [], credentialsLoaded: false, customProviders: [] })
    if (!current || !organizationID) return
    void loadCredentials(current, organizationID).catch((error) => setState("error", fail(error)))
    void loadCustomProviders(current, organizationID).catch((error) => setState("error", fail(error)))
  })

  const openView = (next: "organizations" | "users") => {
    setState({ error: "", resetting: "", newPassword: "" })
    setView(next)
    const current = password()
    // New employee IDs register at any time, so the list is fetched again whenever it is opened.
    if (next === "users" && current) void loadUsers(current)
  }

  const organizations = () =>
    state.organizations.filter((item) => item.name.toLowerCase().includes(state.search.trim().toLowerCase()))

  const members = (organization: AccountOrganization) => {
    const query = state.memberFilter.trim().toLowerCase()

    return query ? organization.members.filter((item) => item.toLowerCase().includes(query)) : organization.members
  }

  const userRows = createMemo(() => {
    const query = state.userSearch.trim().toLowerCase()

    return state.users
      .filter((user) => user.employeeID.toLowerCase().includes(query))
      .map((user) => ({
        ...user,
        organizations: state.organizations.filter((item) => item.members.includes(user.employeeID)),
      }))
  })

  const openOrganization = (id: string) => {
    setSelected(id)
    openView("organizations")
  }

  const startRename = (name: string) => setState({ renaming: true, rename: name })

  return (
    <main data-component="admin-console">
      <aside class="admin-side">
        <div class="admin-brand" role="img" aria-label="OpenCode">
          <Wordmark fade={false} muted={false} />
        </div>
        <nav aria-label={language.t("account.admin.title")}>
          <button
            type="button"
            aria-current={view() === "organizations" ? "page" : undefined}
            onClick={() => openView("organizations")}
          >
            <Icon name="folder" />
            {language.t("account.admin.nav")}
            <span class="admin-count">{state.organizations.length}</span>
          </button>
          <Show when={platform()}>
            <button
              type="button"
              aria-current={view() === "users" ? "page" : undefined}
              onClick={() => openView("users")}
            >
              <Icon name="user" />
              {language.t("account.admin.users")}
              <span class="admin-count">{state.usersLoaded ? state.users.length : "—"}</span>
            </button>
          </Show>
        </nav>
        <div class="admin-account">
          <span class="admin-avatar" aria-hidden="true">
            {props.session.employeeID.slice(0, 2).toUpperCase()}
          </span>
          <div>
            <span class="admin-account-role">{language.t("account.admin.title")}</span>
            <p class="admin-signed-in">
              {language.t("account.admin.signedIn", { employeeID: props.session.employeeID })}
            </p>
          </div>
        </div>
      </aside>
      <section class="admin-main">
        <header class="admin-top">
          <div class="admin-breadcrumb">
            {language.t("account.admin.title")}
            <Icon name="outline-chevron-right" />
            <span>{language.t(view() === "users" ? "account.admin.users" : "account.admin.organizations")}</span>
          </div>
          <div class="admin-top-actions">
            <Show when={props.onClose}>
              <Button variant="ghost" icon="outline-arrow-left" onClick={() => props.onClose?.()}>
                {language.t("account.admin.close")}
              </Button>
            </Show>
            <Button variant="ghost-muted" onClick={props.onLogout}>
              {language.t("account.logout")}
            </Button>
          </div>
        </header>
        <div class="admin-body" data-scrollable>
          <Show when={platform()}>
            <div class="admin-views" role="group" aria-label={language.t("account.admin.title")}>
              <button type="button" aria-pressed={view() === "organizations"} onClick={() => openView("organizations")}>
                {language.t("account.admin.nav")}
              </button>
              <button type="button" aria-pressed={view() === "users"} onClick={() => openView("users")}>
                {language.t("account.admin.users")}
              </button>
            </div>
          </Show>
          <div class="admin-intro">
            <div>
              <h1>{language.t(view() === "users" ? "account.admin.users" : "account.admin.organizations")}</h1>
              <p>{language.t(view() === "users" ? "account.admin.users.description" : "account.admin.description")}</p>
            </div>
            <div class="admin-stats">
              <article class="admin-stat">
                <span>{language.t("account.admin.organizations")}</span>
                <strong>{loaded() ? state.organizations.length : "—"}</strong>
              </article>
              <article class="admin-stat">
                <span>{language.t(view() === "users" ? "account.admin.users" : "account.admin.members")}</span>
                <strong>
                  {view() === "users" ? (state.usersLoaded ? state.users.length : "—") : loaded() ? memberships() : "—"}
                </strong>
              </article>
            </div>
          </div>
          <div class="admin-feedback" aria-live="polite">
            <Show when={state.error}>
              <p class="admin-error" role="alert">
                {state.error}
              </p>
            </Show>
            <Show when={!state.error && state.status}>
              <p class="admin-status" role="status">
                <Icon name="circle-check" />
                {state.status}
              </p>
            </Show>
          </div>
          <Show when={view() === "users"}>
            <section class="admin-users" aria-label={language.t("account.admin.users")}>
              <section class="admin-panel" aria-labelledby="admin-user-list">
                <div class="admin-users-toolbar">
                  <div class="admin-panel-heading">
                    <h2 id="admin-user-list">{language.t("account.admin.users")}</h2>
                    <span class="admin-count">{state.usersLoaded ? userRows().length : "—"}</span>
                  </div>
                  <div class="admin-users-actions">
                    <div class="admin-search admin-users-search">
                      <TextInput
                        type="search"
                        leadingIcon={<Icon name="magnifying-glass" />}
                        aria-label={language.t("account.admin.users.search")}
                        placeholder={language.t("account.admin.users.search")}
                        value={state.userSearch}
                        onInput={(event) => setState("userSearch", event.currentTarget.value)}
                      />
                    </div>
                    <Button type="button" variant="contrast" icon="plus" onClick={openCreateUser}>
                      {language.t("account.admin.users.create")}
                    </Button>
                  </div>
                </div>
                <div class="admin-table-scroll" data-scrollable>
                  <Show
                    when={state.usersLoaded}
                    fallback={
                      <div class="admin-loading">
                        <Loader />
                      </div>
                    }
                  >
                    <Show
                      when={userRows().length > 0}
                      fallback={
                        <p class="admin-empty">
                          {language.t(state.userSearch ? "session.search.noResults" : "account.admin.users.empty")}
                        </p>
                      }
                    >
                      <table class="admin-users-table">
                        <thead>
                          <tr>
                            <th scope="col">{language.t("account.employeeID")}</th>
                            <th scope="col">{language.t("account.admin.organizations")}</th>
                            <th scope="col">
                              <span class="admin-sr-only">{language.t("account.admin.resetPassword")}</span>
                            </th>
                          </tr>
                        </thead>
                        <tbody>
                          <For each={userRows()}>
                            {(row) => (
                              <>
                                <tr>
                                  <td>
                                    <div class="admin-member-identity">
                                      <span class="admin-avatar" aria-hidden="true">
                                        {row.employeeID.slice(0, 2).toUpperCase()}
                                      </span>
                                      <span>{row.employeeID}</span>
                                      <Show when={row.admin}>
                                        <span class="admin-tag admin-badge">
                                          {language.t("account.admin.users.admin")}
                                        </span>
                                      </Show>
                                      <Show when={row.employeeID === props.session.employeeID}>
                                        <span class="admin-tag" data-empty>
                                          {language.t("account.admin.users.you")}
                                        </span>
                                      </Show>
                                    </div>
                                  </td>
                                  <td>
                                    <div class="admin-tags">
                                      <For
                                        each={row.organizations}
                                        fallback={
                                          <span class="admin-tag" data-empty>
                                            {language.t("account.admin.users.noOrganization")}
                                          </span>
                                        }
                                      >
                                        {(organization) => (
                                          <button
                                            type="button"
                                            class="admin-tag"
                                            onClick={() => openOrganization(organization.id)}
                                          >
                                            {organization.name}
                                          </button>
                                        )}
                                      </For>
                                    </div>
                                  </td>
                                  <td class="admin-row-action">
                                    <div class="admin-row-buttons">
                                      <Button
                                        variant="ghost-muted"
                                        disabled={state.pending}
                                        aria-expanded={state.resetting === row.employeeID}
                                        onClick={() =>
                                          setState({
                                            resetting: state.resetting === row.employeeID ? "" : row.employeeID,
                                            newPassword: "",
                                          })
                                        }
                                      >
                                        {language.t("account.admin.resetPassword")}
                                      </Button>
                                      <Show when={row.employeeID !== props.session.employeeID}>
                                        <Button
                                          variant="ghost-muted"
                                          disabled={state.pending}
                                          onClick={() => void setAdmin(row.employeeID, !row.admin)}
                                        >
                                          {language.t(
                                            row.admin
                                              ? "account.admin.users.revokeAdmin"
                                              : "account.admin.users.grantAdmin",
                                          )}
                                        </Button>
                                        <Button
                                          variant="ghost-danger"
                                          disabled={state.pending}
                                          aria-label={language.t("account.admin.users.deleteUser", {
                                            employeeID: row.employeeID,
                                          })}
                                          onClick={() =>
                                            confirmRemoval(
                                              language.t("account.admin.users.deleteConfirm", { employeeID: row.employeeID }),
                                              () => deleteUser(row.employeeID),
                                            )
                                          }
                                        >
                                          {language.t("account.admin.users.delete")}
                                        </Button>
                                      </Show>
                                    </div>
                                  </td>
                                </tr>
                                <Show when={state.resetting === row.employeeID}>
                                  <tr class="admin-reset-row">
                                    <td colSpan={3}>
                                      <form
                                        class="admin-reset"
                                        onSubmit={(event) => {
                                          event.preventDefault()
                                          void resetPassword(row.employeeID)
                                        }}
                                      >
                                        <TextInput
                                          type="password"
                                          autofocus
                                          autocomplete="new-password"
                                          aria-label={language.t("account.admin.newPassword")}
                                          placeholder={language.t("account.admin.newPassword")}
                                          value={state.newPassword}
                                          onInput={(event) => setState("newPassword", event.currentTarget.value)}
                                        />
                                        <Button
                                          type="submit"
                                          variant="contrast"
                                          disabled={state.pending || state.newPassword.length < 8}
                                        >
                                          {language.t("account.admin.setPassword")}
                                        </Button>
                                        <Button
                                          type="button"
                                          variant="ghost"
                                          onClick={() => setState({ resetting: "", newPassword: "" })}
                                        >
                                          {language.t("account.admin.cancel")}
                                        </Button>
                                      </form>
                                    </td>
                                  </tr>
                                </Show>
                              </>
                            )}
                          </For>
                        </tbody>
                      </table>
                    </Show>
                  </Show>
                </div>
              </section>
            </section>
          </Show>
          <div class="admin-workspace" hidden={view() !== "organizations"}>
            <section class="admin-panel admin-directory" aria-labelledby="admin-org-list">
              <div class="admin-panel-heading">
                <h2 id="admin-org-list">{language.t("account.admin.organizations")}</h2>
                <span class="admin-count">{state.organizations.length}</span>
              </div>
              <div class="admin-search">
                <TextInput
                  type="search"
                  leadingIcon={<Icon name="magnifying-glass" />}
                  aria-label={language.t("account.admin.search")}
                  placeholder={language.t("account.admin.search")}
                  value={state.search}
                  onInput={(event) => setState("search", event.currentTarget.value)}
                />
              </div>
              <Show
                when={loaded()}
                fallback={
                  <div class="admin-loading">
                    <Loader />
                  </div>
                }
              >
                <Show
                  when={organizations().length > 0}
                  fallback={
                    <p class="admin-empty">
                      {language.t(state.search ? "account.admin.noResults" : "account.admin.empty")}
                    </p>
                  }
                >
                  <div class="admin-orgs" data-scrollable>
                    <For each={organizations()}>
                      {(organization) => (
                        <button
                          type="button"
                          class="admin-org"
                          aria-pressed={organization.id === selected()}
                          onClick={() => {
                            setSelected(organization.id)
                            setState({ renaming: false, memberFilter: "" })
                          }}
                        >
                          <span class="admin-org-icon" aria-hidden="true">
                            <Icon name="folder" />
                          </span>
                          <span class="admin-org-name">{organization.name}</span>
                          <span class="admin-count" aria-label={language.t("account.admin.members")}>
                            {organization.members.length}
                          </span>
                          <Icon name="outline-chevron-right" />
                        </button>
                      )}
                    </For>
                  </div>
                </Show>
              </Show>
              <Show when={platform()}>
                <div class="admin-create-disclosure">
                  <Button variant="ghost-muted" icon="plus" disabled={state.pending} onClick={() => openCreateOrganization()}>
                    {language.t("account.admin.create")}
                  </Button>
                </div>
              </Show>
            </section>
            <section class="admin-panel admin-detail" aria-labelledby="admin-org-detail" aria-busy={state.pending}>
              <Show
                when={selectedOrganization()}
                keyed
                fallback={
                  <div class="admin-detail-empty">
                    <span class="admin-detail-icon">
                      <Icon name="folder" size="large" />
                    </span>
                    <h2 id="admin-org-detail">{language.t("account.admin.organizations")}</h2>
                    <p>{language.t("account.admin.empty")}</p>
                  </div>
                }
              >
                {(organization) => (
                  <>
                    <div class="admin-detail-heading">
                      <span class="admin-detail-icon" aria-hidden="true">
                        <Icon name="folder" size="large" />
                      </span>
                      <div>
                        <span class="admin-eyebrow">{language.t("account.admin.name")}</span>
                        <Show
                          when={state.renaming}
                          fallback={
                            <h2 id="admin-org-detail">
                              {organization.name}
                              <Show when={platform()}>
                                <button
                                  type="button"
                                  class="admin-rename"
                                  aria-label={language.t("account.admin.renameOrganization")}
                                  title={language.t("account.admin.renameOrganization")}
                                  disabled={state.pending}
                                  onClick={() => startRename(organization.name)}
                                >
                                  <Icon name="edit" size="small" />
                                </button>
                              </Show>
                            </h2>
                          }
                        >
                          <form
                            class="admin-rename-form"
                            onSubmit={(event) => {
                              event.preventDefault()
                              void renameOrganization()
                            }}
                            onKeyDown={(event) => {
                              if (event.key !== "Escape") return
                              event.stopPropagation()
                              setState("renaming", false)
                            }}
                          >
                            <TextInput
                              autofocus
                              required
                              maxLength={80}
                              aria-label={language.t("account.admin.renameOrganization")}
                              value={state.rename}
                              onInput={(event) => setState("rename", event.currentTarget.value)}
                            />
                            <Button type="submit" variant="contrast" disabled={state.pending || !state.rename.trim()}>
                              {language.t("account.admin.save")}
                            </Button>
                            <Button type="button" variant="ghost" onClick={() => setState("renaming", false)}>
                              {language.t("account.admin.cancel")}
                            </Button>
                          </form>
                        </Show>
                      </div>
                      <Show when={platform()}>
                        <Button
                          class="admin-heading-action"
                          variant="ghost-danger"
                          disabled={state.pending}
                          onClick={() =>
                            confirmRemoval(
                              language.t("account.admin.organization.deleteConfirm", { name: organization.name }),
                              () => deleteOrganization(),
                            )
                          }
                        >
                          {language.t("account.admin.organization.delete")}
                        </Button>
                      </Show>
                    </div>
                    <div class="admin-tabs" role="tablist" aria-label={language.t("account.admin.organizations")}>
                      <For each={organizationTabs}>
                        {(tab) => (
                          <button
                            type="button"
                            role="tab"
                            aria-selected={state.tab === tab.id}
                            onClick={() => setState("tab", tab.id)}
                          >
                            {language.t(tab.label)}
                          </button>
                        )}
                      </For>
                    </div>
                    <Show when={state.tab === "pages"}>
                      <div class="admin-pages-heading">
                        <h3>{language.t("account.admin.pages")}</h3>
                        <p>{language.t("account.admin.pages.description")}</p>
                      </div>
                      <fieldset class="admin-pages" disabled={state.pending}>
                        <legend class="admin-sr-only">{language.t("account.admin.pages")}</legend>
                        <For each={Object.keys(pageLabels) as Array<keyof typeof pageLabels>}>
                          {(page) => (
                            <label>
                              <input
                                type="checkbox"
                                checked={organization.settingsPages.includes(page)}
                                disabled={
                                  organization.settingsPages.length === 1 && organization.settingsPages[0] === page
                                }
                                onChange={(event) => void setPage(page, event.currentTarget.checked)}
                              />
                              {language.t(pageLabels[page])}
                            </label>
                          )}
                        </For>
                      </fieldset>
                    </Show>
                    <Show when={state.tab === "credentials"}>
                      <div class="admin-section-head">
                        <div class="admin-pages-heading">
                          <h3>{language.t("account.admin.credentials")}</h3>
                          <p>{language.t("account.admin.credentials.description")}</p>
                        </div>
                        <Button variant="contrast" icon="plus" disabled={state.pending} onClick={() => openCredential()}>
                          {language.t("account.admin.credentials.form")}
                        </Button>
                      </div>
                      <Show
                        when={state.credentialsLoaded}
                        fallback={
                          <div class="admin-loading">
                            <Loader />
                          </div>
                        }
                      >
                        <Show
                          when={state.credentials.length > 0}
                          fallback={<p class="admin-empty admin-empty-members">{language.t("account.admin.credentials.empty")}</p>}
                        >
                          <ul class="admin-cards">
                            <For each={state.credentials}>
                              {(credential) => (
                                <li class="admin-card" data-active={credential.active ? "" : undefined}>
                                  <span class="admin-card-icon" aria-hidden="true">
                                    {credential.integrationID.trim().charAt(0).toUpperCase()}
                                  </span>
                                  <div class="admin-card-body">
                                    <strong>{credential.integrationID}</strong>
                                    <span class="admin-card-meta">
                                      {credential.label}
                                      <Show when={credential.type !== "key"}>
                                        {" · "}
                                        {language.t("account.admin.credentials.oauth")}
                                      </Show>
                                    </span>
                                  </div>
                                  <Show
                                    when={credential.active}
                                    fallback={
                                      <Button
                                        variant="ghost-muted"
                                        disabled={state.pending}
                                        onClick={() => void selectCredential(credential)}
                                      >
                                        {language.t("account.admin.credentials.use")}
                                      </Button>
                                    }
                                  >
                                    <span class="admin-tag admin-badge">{language.t("account.admin.credentials.active")}</span>
                                  </Show>
                                  <Button
                                    variant="ghost-danger"
                                    disabled={state.pending}
                                    aria-label={language.t("account.admin.credentials.remove", { label: credential.label })}
                                    onClick={() =>
                                      confirmRemoval(language.t("account.admin.credentials.remove", { label: credential.label }), () =>
                                        removeCredential(credential),
                                      )
                                    }
                                  >
                                    {language.t("account.admin.remove")}
                                  </Button>
                                </li>
                              )}
                            </For>
                          </ul>
                        </Show>
                      </Show>
                    </Show>
                    <Show when={state.tab === "providers"}>
                      <div class="admin-section-head">
                        <div class="admin-pages-heading">
                          <h3>{language.t("account.admin.custom")}</h3>
                          <p>{language.t("account.admin.custom.description")}</p>
                        </div>
                        <Button variant="contrast" icon="plus" disabled={state.pending} onClick={() => openProvider()}>
                          {language.t("account.admin.custom.form.add")}
                        </Button>
                      </div>
                      <Show
                        when={state.customProviders.length > 0}
                        fallback={<p class="admin-empty admin-empty-members">{language.t("account.admin.custom.empty")}</p>}
                      >
                        <ul class="admin-cards">
                          <For each={state.customProviders}>
                            {(provider) => (
                              <li class="admin-card">
                                <span class="admin-card-icon" aria-hidden="true">
                                  {provider.name.trim().charAt(0).toUpperCase()}
                                </span>
                                <div class="admin-card-body">
                                  <strong>{provider.name}</strong>
                                  <code>{provider.baseURL}</code>
                                  <div class="admin-tags">
                                    <span class="admin-tag">{provider.id}</span>
                                    <span class="admin-tag">
                                      {language.t("account.admin.custom.modelCount", { count: String(provider.models.length) })}
                                    </span>
                                    <Show when={Object.keys(provider.headers ?? {}).length > 0}>
                                      <span class="admin-tag">
                                        {language.t("account.admin.custom.headerCount", {
                                          count: String(Object.keys(provider.headers ?? {}).length),
                                        })}
                                      </span>
                                    </Show>
                                  </div>
                                </div>
                                <div class="admin-card-actions">
                                  <Button variant="ghost-muted" disabled={state.pending} onClick={() => openProvider(provider)}>
                                    {language.t("account.admin.custom.edit")}
                                  </Button>
                                  <Button
                                    variant="ghost-danger"
                                    disabled={state.pending}
                                    aria-label={language.t("account.admin.custom.remove", { name: provider.name })}
                                    onClick={() =>
                                      confirmRemoval(language.t("account.admin.custom.removeConfirm", { name: provider.name }), () =>
                                        removeCustomProvider(provider),
                                      )
                                    }
                                  >
                                    {language.t("account.admin.remove")}
                                  </Button>
                                </div>
                              </li>
                            )}
                          </For>
                        </ul>
                      </Show>
                    </Show>
                    <Show when={state.tab === "members"}>
                      <div class="admin-section-head">
                        <div class="admin-members-heading">
                          <h3>{language.t("account.admin.members")}</h3>
                          <span class="admin-count">{organization.members.length}</span>
                        </div>
                        <Button variant="contrast" icon="plus" disabled={state.pending} onClick={() => openMember()}>
                          {language.t("account.admin.addMember")}
                        </Button>
                      </div>
                      <Show when={organization.members.length > 6}>
                        <div class="admin-search admin-member-filter">
                          <TextInput
                            type="search"
                            leadingIcon={<Icon name="magnifying-glass" />}
                            aria-label={language.t("account.admin.filterMembers")}
                            placeholder={language.t("account.admin.filterMembers")}
                            value={state.memberFilter}
                            onInput={(event) => setState("memberFilter", event.currentTarget.value)}
                          />
                        </div>
                      </Show>
                      <Show
                        when={organization.members.length > 0}
                        fallback={
                          <p class="admin-empty admin-empty-members">{language.t("account.admin.emptyMembers")}</p>
                        }
                      >
                        <Show
                          when={members(organization).length > 0}
                          fallback={
                            <p class="admin-empty admin-empty-members">{language.t("account.admin.noMatches")}</p>
                          }
                        >
                          <table>
                            <thead>
                              <tr>
                                <th scope="col">{language.t("account.employeeID")}</th>
                                <th scope="col">{language.t("account.admin.role")}</th>
                                <th scope="col">
                                  <span class="admin-sr-only">{language.t("account.admin.remove")}</span>
                                </th>
                              </tr>
                            </thead>
                            <tbody>
                              <For each={members(organization)}>
                                {(employeeID) => (
                                  <tr>
                                    <td>
                                      <div class="admin-member-identity">
                                        <span class="admin-avatar" aria-hidden="true">
                                          {employeeID.slice(0, 2).toUpperCase()}
                                        </span>
                                        <span>{employeeID}</span>
                                      </div>
                                    </td>
                                    <td>
                                      <Show
                                        when={platform()}
                                        fallback={
                                          <Show when={organization.admins.includes(employeeID)}>
                                            {language.t("account.admin.role.admin")}
                                          </Show>
                                        }
                                      >
                                        <select
                                          class="admin-role-select"
                                          disabled={state.pending}
                                          aria-label={`${language.t("account.admin.role")}: ${employeeID}`}
                                          value={organization.admins.includes(employeeID) ? "admin" : "member"}
                                          onChange={(event) =>
                                            void setRole(employeeID, event.currentTarget.value === "admin" ? "admin" : "member")
                                          }
                                        >
                                          <option value="admin">{language.t("account.admin.role.admin")}</option>
                                          <option value="member">{language.t("account.admin.role.member")}</option>
                                        </select>
                                      </Show>
                                    </td>
                                    <td class="admin-row-action">
                                      {/* Only a platform admin can remove another admin of the organization. */}
                                      <Show when={platform() || !organization.admins.includes(employeeID)}>
                                        <Button
                                          variant="ghost-danger"
                                          disabled={state.pending}
                                          aria-label={language.t("account.admin.removeMember", { employeeID })}
                                          onClick={() =>
                                            confirmRemoval(language.t("account.admin.removeMember", { employeeID }), () =>
                                              removeMember(employeeID),
                                            )
                                          }
                                        >
                                          {language.t("account.admin.remove")}
                                        </Button>
                                      </Show>
                                    </td>
                                  </tr>
                                )}
                              </For>
                            </tbody>
                          </table>
                        </Show>
                      </Show>
                    </Show>
                  </>
                )}
              </Show>
            </section>
          </div>
        </div>
      </section>
    </main>
  )
}
