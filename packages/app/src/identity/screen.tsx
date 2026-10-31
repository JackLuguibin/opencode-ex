import { createStore } from "solid-js/store"
import { onMount, Show } from "solid-js"
import { Button } from "@opencode/ui/button"
import { Loader } from "@opencode/ui/loader"
import { TextInput } from "@opencode/ui/text-input"
import { Brand } from "@/brand"
import { appTitle } from "@/app-title"
import { useLanguage } from "@/runtime/i18n/language"
import type { ServerConnection } from "@/runtime/server/registry"
import {
  accountFetch,
  AccountError,
  type AccountGuestConfig,
  type AccountSession,
  type AccountUacConfig,
} from "./api"
import "./screen.css"

export function AccountScreen(props: {
  server: ServerConnection.Http
  mode: "login" | "register" | "waiting"
  connectionFailed?: boolean
  onMode: (mode: "login" | "register") => void
  onToken: (token: string) => void
  onSession: (session: AccountSession) => void
  onLogout: () => void
}) {
  const language = useLanguage()
  const [state, setState] = createStore({
    employeeID: "",
    password: "",
    error: "",
    pending: false,
    guest: false,
    guestPending: false,
    entering: false,
    uac: undefined as Required<AccountUacConfig> | undefined,
    uacPending: false,
  })

  // Both sign-in shortcuts are settled before anything is signed in. Signing out marks the tab (see
  // suppressGuestAutoEntry), so it reaches the form instead of silently signing the caller back in.
  onMount(() => {
    void (async () => {
      const [guestConfig, uacConfig] = await Promise.all([
        accountFetch<AccountGuestConfig>({
          url: props.server.http.url,
          path: "/api/auth/guest/config",
        }).catch(() => undefined),
        accountFetch<AccountUacConfig>({
          url: props.server.http.url,
          path: "/api/auth/uac/config",
        }).catch(() => undefined),
      ])
      if (guestConfig?.enabled) setState("guest", true)
      const uac = uacSettings(uacConfig)
      if (uac) setState("uac", uac)
      if (props.mode !== "login" || props.server.http.password || guestEntrySuppressed()) return
      // A real corporate account wins over an anonymous one.
      if (uac && (await uacLogin(uac))) return
      if (!guestConfig?.enabled) return
      setState("entering", true)
      if (!(await guest())) setState("entering", false)
    })()
  })

  const fail = (error: unknown) => {
    if (error instanceof AccountError && error.status === 0) return language.t("account.error.connection")
    if (error instanceof AccountError && error.status === 403) return language.t("account.error.forbidden")
    if (error instanceof AccountError && error.message.toLowerCase().includes("already"))
      return language.t("account.error.taken")
    if (error instanceof AccountError && error.message.toLowerCase().includes("register this"))
      return language.t("account.error.missing")
    if (error instanceof AccountError && (error.status === 400 || error.status === 401))
      return props.mode === "login" ? language.t("account.error.credentials") : language.t("account.error.invalid")
    return language.t("account.error.connection")
  }

  const submit = async () => {
    if (state.pending) return
    setState({ error: "", pending: true })
    try {
      if (props.mode === "login" || props.mode === "register") {
        const path = props.mode === "login" ? "/api/auth/login" : "/api/auth/register"
        const result = await accountFetch<{ token: string }>({
          url: props.server.http.url,
          path,
          body: { employeeID: state.employeeID, password: state.password },
        })
        props.onToken(result.token)
        return
      }
    } catch (error) {
      setState("error", fail(error))
    } finally {
      setState("pending", false)
    }
  }

  const guest = async () => {
    if (state.guestPending) return false
    setState({ error: "", guestPending: true })
    try {
      const result = await accountFetch<{ token: string }>({
        url: props.server.http.url,
        path: "/api/auth/guest",
        method: "POST",
      })
      props.onToken(result.token)
      return true
    } catch (error) {
      setState("error", fail(error))
      return false
    } finally {
      setState("guestPending", false)
    }
  }

  // Signing in through UAC: the login screen asks the corporate credential service who the browser's UAC session
  // belongs to. When there is one it forwards the employee ID and auth key as headers to the backend, which trusts the
  // verification; when there isn't the caller is pointed at the identity portal. Answers false so a caller can fall
  // back to another way in.
  const uacLogin = async (settings: Required<AccountUacConfig>) => {
    if (state.uacPending) return false
    setState("uacPending", true)
    try {
      const credential = await uacCredential(settings.credentialURL, settings.appId)
      if (!credential) return false
      const result = await accountFetch<{ token: string }>({
        url: props.server.http.url,
        path: "/api/auth/uac",
        method: "POST",
        headers: { "x-uac-user": credential.user, "x-uac-token": credential.token },
      })
      props.onToken(result.token)
      return true
    } catch {
      // The backend rejected the credential; the portal button stays available.
      return false
    } finally {
      setState("uacPending", false)
    }
  }

  const redirectUAC = () => {
    const current = state.uac
    if (!current) return
    // The tab may have just signed out, which suppresses the silent sign-in on load; choosing UAC is the explicit
    // intent to go through the portal, so the return keeps the silent sign-in enabled instead of cycling the form.
    clearGuestAutoEntry()
    const url = `${current.uri}/zte-sec-uac-iportal/iportal/#/auth/login?tenant=${current.tenant}&source=${current.appId}&url=${encodeURIComponent(location.href)}`
    location.href = url
  }

  const refresh = async () => {
    const password = props.server.http.password
    if (!password) return
    setState({ error: "", pending: true })
    try {
      const session = await accountFetch<AccountSession>({
        url: props.server.http.url,
        password,
        path: "/api/auth/session",
      })
      props.onSession(session)
    } catch (error) {
      setState("error", fail(error))
    } finally {
      setState("pending", false)
    }
  }

  const title = () => {
    if (props.mode === "register") return language.t("account.register.title")
    if (props.mode === "waiting") return language.t("account.waiting.title")
    return language.t("account.login.title")
  }

  const description = () => {
    if (props.connectionFailed) return language.t("account.error.connection")
    if (props.mode === "register") return language.t("account.register.description")
    if (props.mode === "waiting") return language.t("account.waiting.description")
    if (props.mode === "login") return language.t("account.login.description")
    return ""
  }

  return (
    <main data-component="account-screen" aria-labelledby="account-screen-title">
      <div class="account-screen-content">
        <div class="account-screen-brand" role="img" aria-label={appTitle}>
          <Brand fade={false} muted={false} />
        </div>
        <Show when={!state.entering} fallback={<div class="account-screen-loading"><Loader /></div>}>
          <header>
            <h1 id="account-screen-title">{title()}</h1>
            <Show when={description()}>
              <p>{description()}</p>
            </Show>
          </header>
          <Show when={props.mode === "login" || props.mode === "register"}>
            <form
              onSubmit={(event) => {
                event.preventDefault()
                void submit()
              }}
            >
              <label>
                {language.t("account.employeeID")}
                <TextInput
                  value={state.employeeID}
                  onInput={(event) => setState("employeeID", event.currentTarget.value)}
                  autocomplete="username"
                />
              </label>
              <label>
                {language.t("account.password")}
                <TextInput
                  type="password"
                  value={state.password}
                  onInput={(event) => setState("password", event.currentTarget.value)}
                  autocomplete={props.mode === "login" ? "current-password" : "new-password"}
                />
              </label>
              <Show when={state.error}>
                <p class="account-screen-error">{state.error}</p>
              </Show>
              <Button type="submit" variant="contrast" disabled={state.pending || !!props.connectionFailed}>
                {state.pending
                  ? language.t("account.submitting")
                  : language.t(props.mode === "login" ? "account.login.submit" : "account.register.submit")}
              </Button>
            </form>
            <Show when={props.mode === "login" && state.uac}>
              <div class="account-screen-divider">
                <span>{language.t("account.uac.or")}</span>
              </div>
              <Button variant="ghost" disabled={state.uacPending} onClick={() => void redirectUAC()}>
                {language.t("account.uac.login")}
              </Button>
            </Show>
            <Button
              variant="ghost"
              class="account-screen-switch"
              onClick={() => props.onMode(props.mode === "login" ? "register" : "login")}
            >
              {language.t(props.mode === "login" ? "account.register.switch" : "account.login.switch")}
            </Button>
            <Show when={props.mode === "login" && state.guest}>
              <Button variant="ghost" disabled={state.guestPending} onClick={() => void guest()}>
                {language.t("account.guest.continue")}
              </Button>
            </Show>
          </Show>
          <Show when={props.mode === "waiting"}>
            <Show when={state.error}>
              <p class="account-screen-error">{state.error}</p>
            </Show>
            <Button disabled={state.pending} onClick={() => void refresh()}>
              {language.t("account.waiting.refresh")}
            </Button>
            <Button variant="ghost" onClick={props.onLogout}>
              {language.t("account.logout")}
            </Button>
          </Show>
        </Show>
      </div>
    </main>
  )
}

/** The settings the portal button and the silent sign-in need; absent unless every one of them is configured. */
function uacSettings(config: AccountUacConfig | undefined) {
  if (!config?.enabled || !config.uri || !config.tenant || !config.appId || !config.credentialURL) return
  return { enabled: true, uri: config.uri, tenant: config.tenant, appId: config.appId, credentialURL: config.credentialURL }
}

/**
 * Asks the corporate UAC credential service who the browser's session belongs to, the same call the legacy data-web
 * login made. The configured app ID is appended as a query parameter unless the URL already carries one, and the
 * request sends the browser's cookies so the service can resolve the UAC session.
 */
async function uacCredential(url: string, appId: string) {
  const target = new URL(url)
  if (!target.searchParams.has("appId") && !target.searchParams.has("appid") && !target.searchParams.has("source"))
    target.searchParams.set("appId", appId)
  const response = await fetch(target, { method: "POST", credentials: "include" }).catch(() => undefined)
  if (!response || !response.ok) return
  const body = (await response.json().catch(() => undefined)) as { bo?: { user?: unknown; token?: unknown } } | undefined
  const user = typeof body?.bo?.user === "string" ? body.bo.user.trim() : undefined
  const token = typeof body?.bo?.token === "string" ? body.bo.token : undefined
  if (!user || !token) return
  return { user, token }
}

// A tab that signed out has to land on the form instead of immediately signing back in; the marker lives in session
// storage so a new visit still enters as a guest or through SSO. Without storage, showing the form is the safe
// default rather than guessing.
const GUEST_AUTO_ENTRY_OFF = "opencode.guest.auto-entry-off"

export function suppressGuestAutoEntry() {
  try {
    sessionStorage.setItem(GUEST_AUTO_ENTRY_OFF, "1")
  } catch {
    // Nothing to remember the choice in; the form shows because reading the marker below also fails.
  }
}

function clearGuestAutoEntry() {
  try {
    sessionStorage.removeItem(GUEST_AUTO_ENTRY_OFF)
  } catch {
    // Best effort: a fresh sign-in is still possible through the form.
  }
}

function guestEntrySuppressed() {
  try {
    return sessionStorage.getItem(GUEST_AUTO_ENTRY_OFF) === "1"
  } catch {
    return true
  }
}
