import { createStore } from "solid-js/store"
import { Show } from "solid-js"
import { Button } from "@opencode/ui/button"
import { TextInput } from "@opencode/ui/text-input"
import { Brand } from "@/brand"
import { appTitle } from "@/app-title"
import { useLanguage } from "@/runtime/i18n/language"
import type { ServerConnection } from "@/runtime/server/registry"
import { accountFetch, AccountError, type AccountSession } from "./api"
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
          <Button
            variant="ghost"
            class="account-screen-switch"
            onClick={() => props.onMode(props.mode === "login" ? "register" : "login")}
          >
            {language.t(props.mode === "login" ? "account.register.switch" : "account.login.switch")}
          </Button>
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
      </div>
    </main>
  )
}
