import { createEffect, createMemo, createSignal, For, onCleanup, Show } from "solid-js"
import { Combobox } from "@kobalte/core/combobox"
import { createStore } from "solid-js/store"
import { Button } from "@opencode/ui/button"
import { Icon } from "@opencode/ui/icon"
import { Loader } from "@opencode/ui/loader"
import { TextInput } from "@opencode/ui/text-input"
import { Wordmark } from "@opencode/ui/wordmark"
import { useLanguage } from "@/runtime/i18n/language"
import type { ServerConnection } from "@/runtime/server/registry"
import { pageLabels } from "@/settings/pages"
import { accountFetch, AccountError, type AccountOrganization, type AccountSession, type AccountUser } from "./api"
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
  const [view, setView] = createSignal<"organizations" | "users">("organizations")
  const [state, setState] = createStore({
    search: "",
    name: "",
    member: "",
    memberFilter: "",
    userSearch: "",
    renaming: false,
    rename: "",
    removing: "",
    resetting: "",
    newPassword: "",
    deleting: "",
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
    setState({ error: "", status: "", pending: true, removing: "", deleting: "" })
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
    if (done) setState("name", "")
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

  const addMember = async () => {
    const organization = selectedOrganization()
    const employeeID = state.member.trim()
    if (!organization || !availableUsers().includes(state.member)) return
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
    if (done) setState("member", "")
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
    if (done) setState("creating", { employeeID: "", password: "", organizationID: "", admin: false })
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
    void loadUsers(current)
  })

  const openView = (next: "organizations" | "users") => {
    setState({ error: "", removing: "", deleting: "", resetting: "", newPassword: "" })
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
          <button
            type="button"
            aria-current={view() === "users" ? "page" : undefined}
            onClick={() => openView("users")}
          >
            <Icon name="user" />
            {language.t("account.admin.users")}
            <span class="admin-count">{state.usersLoaded ? state.users.length : "—"}</span>
          </button>
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
          <div class="admin-views" role="group" aria-label={language.t("account.admin.title")}>
            <button type="button" aria-pressed={view() === "organizations"} onClick={() => openView("organizations")}>
              {language.t("account.admin.nav")}
            </button>
            <button type="button" aria-pressed={view() === "users"} onClick={() => openView("users")}>
              {language.t("account.admin.users")}
            </button>
          </div>
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
              <details class="admin-panel admin-create-disclosure admin-create-user" open>
                <summary>
                  <Icon name="plus" />
                  {language.t("account.admin.users.create")}
                  <Icon name="chevron-down" />
                </summary>
                <form
                  class="admin-create admin-create-user-form"
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
              </details>
              <section class="admin-panel" aria-labelledby="admin-user-list">
                <div class="admin-users-toolbar">
                  <div class="admin-panel-heading">
                    <h2 id="admin-user-list">{language.t("account.admin.users")}</h2>
                    <span class="admin-count">{state.usersLoaded ? userRows().length : "—"}</span>
                  </div>
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
                                            setState(
                                              "deleting",
                                              state.deleting === row.employeeID ? "" : row.employeeID,
                                            )
                                          }
                                        >
                                          {language.t("account.admin.users.delete")}
                                        </Button>
                                      </Show>
                                    </div>
                                  </td>
                                </tr>
                                <Show when={state.deleting === row.employeeID}>
                                  <tr class="admin-reset-row">
                                    <td colSpan={3}>
                                      <div class="admin-reset admin-delete-confirm" role="alert">
                                        <span>
                                          {language.t("account.admin.users.deleteConfirm", {
                                            employeeID: row.employeeID,
                                          })}
                                        </span>
                                        <Button
                                          variant="ghost-danger"
                                          autofocus
                                          disabled={state.pending}
                                          onClick={() => void deleteUser(row.employeeID)}
                                        >
                                          {language.t("account.admin.confirmRemove")}
                                        </Button>
                                        <Button variant="ghost" onClick={() => setState("deleting", "")}>
                                          {language.t("account.admin.cancel")}
                                        </Button>
                                      </div>
                                    </td>
                                  </tr>
                                </Show>
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
                            setState({ renaming: false, removing: "", memberFilter: "" })
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
                      maxLength={80}
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
                        <Show
                          when={state.renaming}
                          fallback={
                            <h2 id="admin-org-detail">
                              {organization.name}
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
                    </div>
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
                                  <td class="admin-row-action">
                                    <Show
                                      when={state.removing === employeeID}
                                      fallback={
                                        <Button
                                          variant="ghost-danger"
                                          disabled={state.pending}
                                          aria-label={language.t("account.admin.removeMember", { employeeID })}
                                          onClick={() => setState("removing", employeeID)}
                                        >
                                          {language.t("account.admin.remove")}
                                        </Button>
                                      }
                                    >
                                      <div class="admin-confirm">
                                        <Button
                                          variant="ghost-danger"
                                          disabled={state.pending}
                                          autofocus
                                          aria-label={language.t("account.admin.removeMember", { employeeID })}
                                          onClick={() => void removeMember(employeeID)}
                                        >
                                          {language.t("account.admin.confirmRemove")}
                                        </Button>
                                        <Button variant="ghost" onClick={() => setState("removing", "")}>
                                          {language.t("account.admin.cancel")}
                                        </Button>
                                      </div>
                                    </Show>
                                  </td>
                                </tr>
                              )}
                            </For>
                          </tbody>
                        </table>
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
