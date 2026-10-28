import { createResource, For, Show } from "solid-js"
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
import { accountFetch, AccountError, type AccountOrganization, type AccountSharedMcp } from "./api"
import { useAccountOptional } from "./gate"
import { OrganizationPicker } from "./organization-picker"
import "./global-packages.css"

/** `Name: value` lines (headers) or `NAME=value` lines (environment) into a record; blank lines are skipped. */
function parsePairs(text: string, separator: ":" | "=") {
  return Object.fromEntries(
    text
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .flatMap((line) => {
        const at = line.indexOf(separator)
        return at > 0 ? [[line.slice(0, at).trim(), line.slice(at + 1).trim()] as const] : []
      }),
  )
}

/**
 * MCP servers shared by platform admins with the organizations they are opened to. Platform admins create, scope and
 * delete them; admins of the current organization switch them on or off for it; everyone else only sees the list.
 */
export function SharedMcp() {
  const account = useAccountOptional()
  const language = useLanguage()
  const dialog = useDialog()
  const [state, setState] = createStore({
    name: "",
    type: "remote" as "remote" | "local",
    url: "",
    headers: "",
    command: "",
    environment: "",
    trusted: false,
    organizations: [] as string[],
    pending: false,
    deleting: "",
    editing: "",
    draft: [] as string[],
  })
  const [servers, { refetch }] = createResource(
    () => account?.session.employeeID,
    () =>
      accountFetch<AccountSharedMcp[]>({
        url: account!.server.http.url,
        password: account!.server.http.password,
        path: "/api/shared-mcp",
      }).catch(() => [] as AccountSharedMcp[]),
    { initialValue: [] },
  )
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

  const call = async (input: { path: string; method?: string; body?: unknown }) => {
    setState("pending", true)
    try {
      await accountFetch({ url: account!.server.http.url, password: account!.server.http.password, ...input })
      await refetch()
      return true
    } catch (error) {
      showToast({
        variant: "error",
        title: language.t("account.packages.mcp.failed"),
        description: error instanceof AccountError ? error.message : undefined,
      })
      return false
    } finally {
      setState("pending", false)
    }
  }

  const create = async () => {
    const missing = !state.name.trim()
      ? "account.packages.mcp.missing.name"
      : state.type === "remote" && !state.url.trim()
        ? "account.packages.mcp.missing.url"
        : state.type === "local" && !state.command.trim()
          ? "account.packages.mcp.missing.command"
          : state.organizations.length === 0
            ? "account.packages.missing.organizations"
            : state.type === "local" && !state.trusted
              ? "account.packages.mcp.missing.trust"
              : undefined
    if (missing) {
      showToast({ variant: "error", title: language.t(missing) })
      return
    }
    const ok = await call({
      path: "/api/shared-mcp",
      body: {
        name: state.name.trim(),
        type: state.type,
        organizations: state.organizations,
        ...(state.type === "remote"
          ? { url: state.url.trim(), headers: parsePairs(state.headers, ":") }
          : { command: state.command.trim().split(/\s+/), environment: parsePairs(state.environment, "=") }),
      },
    })
    if (ok) dialog.close()
  }

  const openCreate = () => {
    setState({ name: "", type: "remote", url: "", headers: "", command: "", environment: "", trusted: false, organizations: [] })
    void dialog.show(() => (
      <Dialog fit>
        <DialogHeader>
          <DialogTitleGroup title={language.t("account.packages.mcp.add")} />
        </DialogHeader>
        <DialogBody>
          <form
            data-component="package-upload"
            onSubmit={(event) => {
              event.preventDefault()
              void create()
            }}
          >
            <label class="package-field">
              {language.t("account.packages.mcp.name")}
              <TextInput autocomplete="off" value={state.name} onInput={(event) => setState("name", event.currentTarget.value)} />
            </label>
            <div class="package-field">
              <div class="flex gap-4 text-13-regular text-v2-text-text-base">
                <For each={["remote", "local"] as const}>
                  {(type) => (
                    <label class="flex items-center gap-1">
                      <input type="radio" name="mcp-type" checked={state.type === type} onChange={() => setState("type", type)} />
                      {language.t(`account.packages.mcp.type.${type}`)}
                    </label>
                  )}
                </For>
              </div>
            </div>
            <Show
              when={state.type === "remote"}
              fallback={
                <>
                  <label class="package-field">
                    {language.t("account.packages.mcp.command")}
                    <TextInput
                      autocomplete="off"
                      value={state.command}
                      onInput={(event) => setState("command", event.currentTarget.value)}
                    />
                  </label>
                  <label class="package-field">
                    {language.t("account.packages.mcp.environment")}
                    <textarea
                      rows={3}
                      value={state.environment}
                      onInput={(event) => setState("environment", event.currentTarget.value)}
                    />
                  </label>
                </>
              }
            >
              <label class="package-field">
                {language.t("account.packages.mcp.url")}
                <TextInput autocomplete="off" value={state.url} onInput={(event) => setState("url", event.currentTarget.value)} />
              </label>
              <label class="package-field">
                {language.t("account.packages.mcp.headers")}
                <textarea rows={3} value={state.headers} onInput={(event) => setState("headers", event.currentTarget.value)} />
              </label>
            </Show>
            <div class="package-field">
              {language.t("account.packages.organizations")}
              <OrganizationPicker
                organizations={organizations.latest ?? []}
                selected={state.organizations}
                onChange={(next) => setState("organizations", next)}
              />
            </div>
            <Show when={state.type === "local"}>
              <label class="package-trust">
                <input type="checkbox" checked={state.trusted} onChange={(event) => setState("trusted", event.currentTarget.checked)} />
                {language.t("account.packages.mcp.trust")}
              </label>
            </Show>
            <div class="package-actions">
              <Button type="button" variant="ghost" onClick={() => dialog.close()}>
                {language.t("account.admin.cancel")}
              </Button>
              <Button type="submit" variant="contrast" icon="plus" disabled={state.pending}>
                {language.t("account.packages.mcp.add")}
              </Button>
            </div>
          </form>
        </DialogBody>
      </Dialog>
    ))
  }

  return (
    <Show when={account}>
      {(current) => (
        <div class="settings-section" data-component="shared-mcp">
          <div class="flex items-start justify-between gap-4">
            <div class="flex flex-col gap-1">
              <span class="settings-extension-heading text-13-medium">{language.t("account.packages.mcp.title")}</span>
              <span class="text-13-regular text-v2-text-text-muted">{language.t("account.packages.mcp.description")}</span>
            </div>
            <Show when={current().session.admin}>
              <Button variant="contrast" icon="plus" class="shrink-0" onClick={openCreate}>
                {language.t("account.packages.mcp.add")}
              </Button>
            </Show>
          </div>
          <SettingsList variant="catalog">
            <Show
              when={(servers.latest ?? []).length > 0}
              fallback={<div class="settings-extension-row text-v2-text-text-muted">{language.t("account.packages.mcp.empty")}</div>}
            >
              <For each={servers.latest ?? []}>
                {(item) => (
                  <div class="settings-extension-row flex-wrap">
                    <div class="settings-extension-lead">
                      <Icon name="mcp" class="text-v2-icon-icon-muted shrink-0" />
                      <div class="flex min-w-0 flex-col">
                        <span class="settings-extension-name truncate">{item.name}</span>
                        <Show when={current().session.admin}>
                          <span class="truncate text-11-regular text-v2-text-text-muted">{item.target}</span>
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
                            void call({
                              path: `/api/organization/${current().session.organizationID}/shared-mcp/${encodeURIComponent(item.name)}`,
                              method: "PUT",
                              body: { enabled },
                            })
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
                              void call({ path: `/api/shared-mcp/${encodeURIComponent(item.name)}`, method: "DELETE" }).then(() =>
                                setState("deleting", ""),
                              )
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
                        <OrganizationPicker
                          organizations={organizations.latest ?? []}
                          selected={state.draft}
                          onChange={(next) => setState("draft", next)}
                        />
                        <Button
                          variant="contrast"
                          disabled={state.pending}
                          onClick={() =>
                            void call({
                              path: `/api/shared-mcp/${encodeURIComponent(item.name)}/organizations`,
                              method: "PUT",
                              body: { organizations: state.draft },
                            }).then((ok) => ok && setState("editing", ""))
                          }
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
