import { createEffect, createSignal, For, Show } from "solid-js"
import { Combobox } from "@kobalte/core/combobox"
import { createStore } from "solid-js/store"
import { Button } from "@opencode/ui/button"
import { Icon } from "@opencode/ui/icon"
import { Loader } from "@opencode/ui/loader"
import { TextInput } from "@opencode/ui/text-input"
import { Wordmark } from "@opencode/ui/wordmark"
import { useLanguage } from "@/runtime/i18n/language"
import type { ServerConnection } from "@/runtime/server/registry"
import { accountFetch, AccountError, type AccountOrganization, type AccountSession } from "./api"
import "./admin.css"

export function AdminConsole(props: {
  server: ServerConnection.Http
  session: AccountSession
  onSession: (session: AccountSession) => void
  onLogout: () => void
  onClose?: () => void
}) {
  const language = useLanguage()
  const [selected, setSelected] = createSignal<string>()
  const [loaded, setLoaded] = createSignal(false)
  const [state, setState] = createStore({
    search: "",
    name: "",
    member: "",
    users: [] as string[],
    usersLoaded: false,
    organizations: [] as AccountOrganization[],
    error: "",
    pending: false,
  })

  const fail = (error: unknown) => {
    if (error instanceof AccountError && error.status === 403) return language.t("account.error.forbidden")
    if (error instanceof AccountError && error.message.toLowerCase().includes("register this"))
      return language.t("account.error.missing")
    if (error instanceof AccountError && (error.status === 400 || error.status === 401))
      return language.t("account.error.invalid")
    return language.t("account.error.connection")
  }

  const password = () => props.server.http.password

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

  const createOrganization = async () => {
    const current = password()
    if (!current || !state.name.trim() || state.pending) return
    setState({ error: "", pending: true })
    try {
      const created = await accountFetch<AccountOrganization>({
        url: props.server.http.url,
        password: current,
        path: "/api/organization",
        body: { name: state.name.trim() },
      })
      setState("name", "")
      setSelected(created.id)
      await loadOrganizations(current)
      await refreshSession(current)
    } catch (error) {
      setState("error", fail(error))
    } finally {
      setState("pending", false)
    }
  }

  const addMember = async () => {
    const current = password()
    const organizationID = selected()
    if (!current || !organizationID || !availableUsers().includes(state.member) || state.pending) return
    setState({ error: "", pending: true })
    try {
      await accountFetch({
        url: props.server.http.url,
        password: current,
        path: `/api/organization/${encodeURIComponent(organizationID)}/member`,
        body: { employeeID: state.member.trim() },
      })
      setState("member", "")
      await loadOrganizations(current)
      await refreshSession(current)
    } catch (error) {
      setState("error", fail(error))
    } finally {
      setState("pending", false)
    }
  }

  const removeMember = async (employeeID: string) => {
    const current = password()
    const organizationID = selected()
    if (!current || !organizationID || state.pending) return
    setState({ error: "", pending: true })
    try {
      await accountFetch({
        url: props.server.http.url,
        password: current,
        path: `/api/organization/${encodeURIComponent(organizationID)}/member/${encodeURIComponent(employeeID)}`,
        method: "DELETE",
      })
      await loadOrganizations(current)
      await refreshSession(current)
    } catch (error) {
      setState("error", fail(error))
    } finally {
      setState("pending", false)
    }
  }

  const selectedOrganization = () => state.organizations.find((item) => item.id === selected())
  const availableUsers = () => state.users.filter((employeeID) => !selectedOrganization()?.members.includes(employeeID))
  const memberships = () => state.organizations.reduce((sum, item) => sum + item.members.length, 0)

  createEffect(() => {
    const current = password()
    if (!current) return
    void loadOrganizations(current).catch((error) => setState("error", fail(error)))
    void accountFetch<string[]>({
      url: props.server.http.url,
      password: current,
      path: "/api/auth/users",
    }).then(
      (users) => setState({ users, usersLoaded: true }),
      (error) => setState("error", fail(error)),
    )
  })

  const organizations = () =>
    state.organizations.filter((item) => item.name.toLowerCase().includes(state.search.trim().toLowerCase()))

  return (
    <main data-component="admin-console">
      <aside class="admin-side">
        <div class="admin-brand" role="img" aria-label="OpenCode">
          <Wordmark fade={false} muted={false} />
        </div>
        <nav aria-label={language.t("account.admin.title")}>
          <span aria-current="page">
            <Icon name="folder" />
            {language.t("account.admin.nav")}
            <span class="admin-count">{state.organizations.length}</span>
          </span>
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
            <span>{language.t("account.admin.organizations")}</span>
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
          <div class="admin-intro">
            <div>
              <h1>{language.t("account.admin.organizations")}</h1>
              <p>{language.t("account.admin.description")}</p>
            </div>
            <div class="admin-stats">
              <article class="admin-stat">
                <span>{language.t("account.admin.organizations")}</span>
                <strong>{loaded() ? state.organizations.length : "—"}</strong>
              </article>
              <article class="admin-stat">
                <span>{language.t("account.admin.members")}</span>
                <strong>{loaded() ? memberships() : "—"}</strong>
              </article>
            </div>
          </div>
          <Show when={state.error}>
            <p class="admin-error" role="alert">
              {state.error}
            </p>
          </Show>
          <div class="admin-workspace">
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
                          onClick={() => setSelected(organization.id)}
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
              <details class="admin-create-disclosure">
                <summary>
                  <Icon name="plus" />
                  {language.t("account.admin.create")}
                </summary>
                <form
                  class="admin-create"
                  onSubmit={(event) => {
                    event.preventDefault()
                    void createOrganization()
                  }}
                >
                  <label>
                    {language.t("account.admin.name")}
                    <TextInput
                      required
                      value={state.name}
                      onInput={(event) => setState("name", event.currentTarget.value)}
                    />
                  </label>
                  <Button type="submit" variant="contrast" disabled={state.pending || !state.name.trim()}>
                    {language.t("account.admin.create")}
                  </Button>
                </form>
              </details>
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
                        <h2 id="admin-org-detail">{organization.name}</h2>
                      </div>
                    </div>
                    <div class="admin-members-heading">
                      <h3>{language.t("account.admin.members")}</h3>
                      <span class="admin-count">{organization.members.length}</span>
                    </div>
                    <form
                      class="admin-member"
                      onSubmit={(event) => {
                        event.preventDefault()
                        void addMember()
                      }}
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
                      <Button
                        type="submit"
                        variant="contrast"
                        icon="plus"
                        disabled={state.pending || !availableUsers().includes(state.member)}
                      >
                        {language.t("account.admin.add")}
                      </Button>
                    </form>
                    <Show
                      when={organization.members.length > 0}
                      fallback={
                        <p class="admin-empty admin-empty-members">{language.t("account.admin.emptyMembers")}</p>
                      }
                    >
                      <table>
                        <thead>
                          <tr>
                            <th scope="col">{language.t("account.employeeID")}</th>
                            <th scope="col">
                              <span class="admin-sr-only">{language.t("account.admin.remove")}</span>
                            </th>
                          </tr>
                        </thead>
                        <tbody>
                          <For each={organization.members}>
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
                                <td class="admin-row-action">
                                  <Button
                                    variant="ghost-danger"
                                    disabled={state.pending}
                                    aria-label={language.t("account.admin.removeMember", { employeeID })}
                                    onClick={() => void removeMember(employeeID)}
                                  >
                                    {language.t("account.admin.remove")}
                                  </Button>
                                </td>
                              </tr>
                            )}
                          </For>
                        </tbody>
                      </table>
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
