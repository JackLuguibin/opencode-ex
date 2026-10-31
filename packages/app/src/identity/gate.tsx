import { useLocation, useNavigate } from "@solidjs/router"
import { createComputed, createContext, createEffect, createSignal, onCleanup, Show, untrack, useContext, type ParentProps } from "solid-js"
import { Avatar } from "@opencode/ui/avatar"
import { Button } from "@opencode/ui/button"
import { Icon } from "@opencode/ui/icon"
import { Loader } from "@opencode/ui/loader"
import { Menu } from "@opencode/ui/menu"
import { useDialog } from "@opencode/ui/context/dialog"
import { useLanguage } from "@/runtime/i18n/language"
import { PluginPromptDialog } from "@/runtime/plugin/dialogs"
import { queueOrganizationReset } from "./organization-state"
import { ServerConnection, useServers } from "@/runtime/server/registry"
import { hydrateRemote, resetRemote, setAccountActive } from "@/runtime/persistence/remote"
import { accountFetch, AccountError, type AccountJoinRequest, type AccountSession } from "./api"
import { AdminConsole } from "./admin"
import { JoinApprovalDialog, JoinRequestDialog } from "./join-requests"
import { UsageDialog } from "./usage"
import { AccountScreen, suppressGuestAutoEntry } from "./screen"
import "./screen.css"

const AccountContext = createContext<{
  session: AccountSession
  server: ServerConnection.Http
  reload: () => Promise<void>
  logout: () => Promise<void>
  openAdmin: () => void
}>()

/** The signed-in account, or undefined where no account gate guards the server. */
export function useAccountOptional() {
  return useContext(AccountContext)
}

export function useAccount() {
  const value = useContext(AccountContext)
  if (!value) throw new Error("Account context is missing")
  return value
}

export function AccountGate(props: ParentProps<{ server: ServerConnection.Http; connectionFailed?: boolean }>) {
  const servers = useServers()
  const navigate = useNavigate()
  const location = useLocation()
  const [session, setSession] = createSignal<AccountSession>()
  const [mode, setMode] = createSignal<"login" | "register">("login")
  // The gateway answers 503 while the organization's execution layer is down; that is not a sign-out.
  const [unavailable, setUnavailable] = createSignal(false)
  const language = useLanguage()
  const admin = () => location.pathname === "/admin"


  // Tabs restored from another organization can't be opened here; drop them and start over once.
  createComputed(() => {
    const organizationID = session()?.organizationID

    // Back to the start page too: the address itself can name the other organization's directory.
    if (organizationID && queueOrganizationReset(organizationID)) window.location.replace("/")
  })

  // Computed rather than an effect so the app never renders with another organization's servers.
  createComputed(() => servers.setOrganization(session()?.organizationID))

  // The account's stored client state is loaded before the app renders, so stores read it synchronously. If the
  // server can't supply it, stores keep using this browser's own storage rather than treating it as empty.
  const [hydrated, setHydrated] = createSignal<string>()
  // It needs only the token, so it loads alongside the session check instead of after it.
  let early: { readonly password: string; readonly load: Promise<void> } | undefined
  const hydrationKey = () => {
    const current = session()
    return current ? `${current.employeeID}\u0000${current.organizationID ?? ""}` : undefined
  }
  createEffect(() => {
    const key = hydrationKey()
    const password = props.server.http.password
    setAccountActive(!!key && !!password)
    if (!key || !password) {
      setHydrated(undefined)
      return
    }
    if (untrack(hydrated) === key) return
    const prefetched = early?.password === password ? early.load : undefined
    early = undefined
    if (!prefetched) resetRemote()
    void (prefetched ?? hydrateRemote({ url: props.server.http.url, password }))
      .catch((error) => console.error("[persistence] loading the account's state failed", error))
      .finally(() => setHydrated(key))
  })

  const logout = async () => {
    const password = props.server.http.password
    resetRemote()
    if (password) {
      await accountFetch({
        url: props.server.http.url,
        password,
        path: "/api/auth/logout",
        method: "POST",
      }).catch(() => undefined)
    }
    servers.add({ type: "http", http: { url: props.server.http.url } })
    setSession(undefined)
    setMode("login")
    // Signing out must reach the form, not a fresh guest account.
    suppressGuestAutoEntry()
    // Stores built for this account stay in memory; a fresh page is the only way the next account never sees them.
    window.location.replace("/")
  }

  const reload = async () => {
    const password = props.server.http.password
    if (!password) return
    try {
      const next = await accountFetch<AccountSession>({
        url: props.server.http.url,
        password,
        path: "/api/auth/session",
      })
      setSession(next)
      setUnavailable(false)
    } catch (error) {
      if (error instanceof AccountError && error.status === 401) {
        servers.add({ type: "http", http: { url: props.server.http.url } })
        setSession(undefined)
        return
      }
      setUnavailable(true)
    }
  }

  createEffect(() => {
    if (!unavailable()) return
    const timer = setInterval(() => void reload(), 5_000)
    onCleanup(() => clearInterval(timer))
  })

  createEffect(() => {
    const password = props.server.http.password
    if (!password) {
      setSession(undefined)
      return
    }
    const load = hydrateRemote({ url: props.server.http.url, password })
    early = { password, load }
    // Consumed once the session is known; a failure there is reported then.
    load.catch(() => undefined)
    void reload()
  })

  createEffect(() => {
    const current = session()
    if (!current || current.admin || current.organizationAdmin || location.pathname !== "/admin") return
    navigate("/", { replace: true })
  })

  return (
    <Show
      // Not keyed: a refreshed session must update in place, not remount the app and reset the admin console.
      when={session()}
      fallback={
        <Show
          when={props.server.http.password}
          fallback={
            <AccountScreen
              server={props.server}
              mode={mode()}
              connectionFailed={props.connectionFailed}
              onMode={setMode}
              onToken={(token) => {
                servers.add({ type: "http", http: { url: props.server.http.url, password: token } })
              }}
              onSession={setSession}
              onLogout={() => void logout()}
            />
          }
        >
          <Show when={unavailable()} fallback={<Loader />}>
            <div data-component="account-unavailable">
              <p>{language.t("account.error.connection")}</p>
              <Button variant="contrast" onClick={() => void reload()}>
                {language.t("account.retry")}
              </Button>
            </div>
          </Show>
        </Show>
      }
    >
      {(current) => (
        <Show
          when={current().organizationID && !admin()}
          fallback={
            <Show
              when={(current().admin || current().organizationAdmin) && (admin() || !current().organizationID)}
              fallback={
                <AccountScreen
                  server={props.server}
                  mode="waiting"
                  onMode={setMode}
                  onToken={() => undefined}
                  onSession={setSession}
                  onLogout={() => void logout()}
                />
              }
            >
              <AdminConsole
                server={props.server}
                session={current()}
                onSession={setSession}
                onLogout={() => void logout()}
                onClose={current().organizationID ? () => navigate(-1) : undefined}
              />
            </Show>
          }
        >
          <AccountContext.Provider
            value={{
              get session() {
                return current()
              },
              server: props.server,
              reload,
              logout,
              openAdmin: () => navigate("/admin"),
            }}
          >
            <Show when={hydrated() === hydrationKey()} fallback={<Loader />}>
              {props.children}
            </Show>
          </AccountContext.Provider>
        </Show>
      )}
    </Show>
  )
}

export function AccountBar() {
  const account = useAccount()
  const language = useLanguage()

  const switchOrganization = async (organizationID: string) => {
    const password = account.server.http.password
    if (!password) return
    await accountFetch<AccountSession>({
      url: account.server.http.url,
      password,
      path: "/api/auth/organization",
      body: { organizationID },
    })
    // Project lists, sessions and sync state are cached per server connection, which an organization switch
    // does not change. Reloading is the one way to drop all of it so only the new organization's data shows.
    // The gate clears the old organization's tabs on the way back in.
    window.location.assign("/")
  }

  const dialog = useDialog()
  // Admins are told how many requests wait for them, and an applicant's approved request becomes a new organization.
  const [waiting, setWaiting] = createSignal(0)
  const poll = () => {
    const request = <T,>(path: string) =>
      accountFetch<T>({ url: account.server.http.url, password: account.server.http.password, path })
    void request<AccountJoinRequest[]>("/api/auth/join-requests/pending")
      .then((items) => setWaiting(items.length))
      .catch(() => undefined)
    void request<AccountJoinRequest[]>("/api/auth/join-requests")
      .then((items) => {
        const joined = new Set(account.session.organizations.map((item) => item.id))
        if (items.some((item) => item.status === "approved" && !joined.has(item.organizationID))) void account.reload()
      })
      .catch(() => undefined)
  }
  poll()
  const timer = setInterval(poll, 60_000)
  onCleanup(() => clearInterval(timer))
  const openJoin = () => dialog.show(() => <JoinRequestDialog server={account.server} sent={poll} />)
  const openApprovals = () =>
    dialog.show(() => <JoinApprovalDialog server={account.server} changed={(pending) => { setWaiting(pending); void account.reload() }} />)
  const openUsage = () =>
    dialog.show(() => (
      <UsageDialog
        server={account.server}
        organizationID={account.session.organizationID ?? ""}
        admin={account.session.admin || account.session.organizationAdmin}
      />
    ))
  const displayName = () =>
    account.session.name || (account.session.guest ? language.t("account.guest") : account.session.employeeID)
  const rename = () =>
    dialog.show(() => (
      <PluginPromptDialog
        options={{
          title: language.t("account.name.change"),
          placeholder: language.t("account.name.placeholder"),
          value: account.session.name ?? "",
        }}
        done={(value) => {
          dialog.close()
          const name = value?.trim()
          if (!name || name === account.session.name) return
          void accountFetch({
            url: account.server.http.url,
            password: account.server.http.password,
            path: `/api/auth/users/${encodeURIComponent(account.session.employeeID)}/name`,
            method: "PUT",
            body: { name },
          })
            .then(() => account.reload())
            .catch(() => undefined)
        }}
      />
    ))

  return (
    <div data-component="account-bar">
      <label>
        {language.t("account.org.label")}
        <Show
          when={account.session.organizations.length > 1}
          fallback={<span>{account.session.organizations.find((item) => item.id === account.session.organizationID)?.name}</span>}
        >
          <select
            value={account.session.organizationID}
            onChange={(event) => void switchOrganization(event.currentTarget.value)}
          >
            {account.session.organizations.map((organization) => (
              <option value={organization.id}>{organization.name}</option>
            ))}
          </select>
        </Show>
      </label>
      <Menu gutter={4} placement="bottom-end">
        <Menu.Trigger
          as={Button}
          variant="ghost"
          class="account-profile"
          aria-label={language.t("account.profile")}
        >
          <Avatar fallback={displayName()} size="small" />
          <span title={account.session.employeeID}>{displayName()}</span>
          <Icon name="chevron-down" size="small" />
        </Menu.Trigger>
        <Menu.Portal>
          <Menu.Content>
            <Show when={!account.session.admin}>
              <Menu.Item onSelect={openJoin}>{language.t("account.join.open")}</Menu.Item>
            </Show>
            <Show when={account.session.admin || account.session.organizationAdmin || waiting() > 0}>
              <Menu.Item onSelect={openApprovals}>
                {language.t("account.join.approvals")}
                <Show when={waiting() > 0}> ({waiting()})</Show>
              </Menu.Item>
            </Show>
            <Show when={account.session.organizationID}>
              <Menu.Item onSelect={openUsage}>
                {language.t(account.session.admin || account.session.organizationAdmin ? "account.usage.nav" : "account.usage.navOwn")}
              </Menu.Item>
            </Show>
            <Show when={account.session.admin || account.session.organizationAdmin}>
              <Menu.Item onSelect={account.openAdmin}>{language.t("account.admin.open")}</Menu.Item>
            </Show>
            <Menu.Separator />
            <Show when={account.session.admin}>
              <Menu.Item onSelect={rename}>{language.t("account.name.change")}</Menu.Item>
            </Show>
            <Menu.Item onSelect={() => void account.logout()}>{language.t("account.logout")}</Menu.Item>
          </Menu.Content>
        </Menu.Portal>
      </Menu>
    </div>
  )
}
