import { useLocation, useNavigate } from "@solidjs/router"
import { createComputed, createContext, createEffect, createSignal, Show, useContext, type ParentProps } from "solid-js"
import { Avatar } from "@opencode/ui/avatar"
import { Button } from "@opencode/ui/button"
import { Icon } from "@opencode/ui/icon"
import { Loader } from "@opencode/ui/loader"
import { Menu } from "@opencode/ui/menu"
import { useLanguage } from "@/runtime/i18n/language"
import { queueOrganizationReset } from "./organization-state"
import { ServerConnection, useServers } from "@/runtime/server/registry"
import { accountFetch, AccountError, type AccountSession } from "./api"
import { AdminConsole } from "./admin"
import { AccountScreen } from "./screen"
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
  const admin = () => location.pathname === "/admin"


  // Tabs restored from another organization can't be opened here; drop them and start over once.
  createComputed(() => {
    const organizationID = session()?.organizationID

    // Back to the start page too: the address itself can name the other organization's directory.
    if (organizationID && queueOrganizationReset(organizationID)) window.location.replace("/")
  })

  // Computed rather than an effect so the app never renders with another organization's servers.
  createComputed(() => servers.setOrganization(session()?.organizationID))

  const logout = async () => {
    const password = props.server.http.password
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
    if (admin()) navigate("/", { replace: true })
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
    } catch (error) {
      if (error instanceof AccountError && error.status === 401) {
        servers.add({ type: "http", http: { url: props.server.http.url } })
        setSession(undefined)
      }
    }
  }

  createEffect(() => {
    const password = props.server.http.password
    if (!password) {
      setSession(undefined)
      return
    }
    void reload()
  })

  createEffect(() => {
    const current = session()
    if (!current || current.admin || location.pathname !== "/admin") return
    navigate("/", { replace: true })
  })

  return (
    <Show
      when={session()}
      keyed
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
          <Loader />
        </Show>
      }
    >
      {(current) => (
        <Show
          when={current.organizationID && !admin()}
          fallback={
            <Show
              when={current.admin && (admin() || !current.organizationID)}
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
                session={current}
                onSession={setSession}
                onLogout={() => void logout()}
                onClose={current.organizationID ? () => navigate(-1) : undefined}
              />
            </Show>
          }
        >
          <AccountContext.Provider
            value={{
              session: current,
              server: props.server,
              reload,
              logout,
              openAdmin: () => navigate("/admin"),
            }}
          >
            {props.children}
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
          <Avatar fallback={account.session.employeeID} size="small" />
          <span>{account.session.employeeID}</span>
          <Icon name="chevron-down" size="small" />
        </Menu.Trigger>
        <Menu.Portal>
          <Menu.Content>
            <Show when={account.session.admin}>
              <Menu.Item onSelect={account.openAdmin}>{language.t("account.admin.open")}</Menu.Item>
              <Menu.Separator />
            </Show>
            <Menu.Item onSelect={() => void account.logout()}>{language.t("account.logout")}</Menu.Item>
          </Menu.Content>
        </Menu.Portal>
      </Menu>
    </div>
  )
}
