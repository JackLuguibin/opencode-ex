import { Button } from "@opencode/ui/button"
import { Badge } from "@opencode/ui/badge"
import { useDialog } from "@opencode/ui/context/dialog"
import { Icon } from "@opencode/ui/icon"
import { IconButton } from "@opencode/ui/icon-button"
import { Menu } from "@opencode/ui/menu"
import { showToast } from "@/shell/notifications/toast"
import { useProviders } from "@/providers/catalog/providers"
import { useIntegrations } from "@/providers/catalog/integrations"
import { createEffect, createMemo, createResource, type Component, For, type JSX, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { useLanguage } from "@/runtime/i18n/language"
import { useServerSDK } from "@/runtime/server/client"
import { formatServerError } from "@/runtime/server/errors"
import { DialogConnectProvider, useProviderConnectController } from "@/providers/connect/dialog"
import { ProviderModelIcon } from "@/providers/models/provider-group"
import { SettingsList } from "@/settings/list"
import { activeProviderAccount, providerAccounts, type ProviderAccount } from "./accounts"
import { AccountNameInput } from "./account-name"
import { useProviderAccountActions } from "./account-actions"
import { globalCredentialIntegration, isGlobalCredential, removeUserCredential } from "@/identity/credentials"
import { accountFetch } from "@/identity/api"
import { useAccountOptional } from "@/identity/gate"
import { DialogPersonalProvider, type PersonalProvider } from "./personal-provider"
import { isPersonalProvider, useCredentialScopes } from "./scope"
import "@/settings/settings.css"

type ProviderSource = "env" | "api" | "account" | "config" | "custom"

type ProviderItem = ReturnType<ReturnType<typeof useProviders>["connected"]>[number]

export const SettingsProviders: Component<{
  directory: string | undefined
  onSelectProvider?: (providerID: string) => void
  headerAction?: JSX.Element
}> = (props) => {
  const dialog = useDialog()
  const language = useLanguage()
  const serverSdk = useServerSDK()
  const identity = useAccountOptional()
  const providers = useProviders(() => props.directory)
  const integrations = useIntegrations(() => props.directory)
  const providerConnect = useProviderConnectController()
  const accountActions = useProviderAccountActions(() => props.directory)

  const [state, setState] = createStore<{
    disconnecting: Record<string, "removing" | "removed" | "absent" | undefined>
    credentialID?: string
    renaming?: string
    held?: ProviderItem[]
  }>({
    disconnecting: {},
  })

  const updateDisconnecting = (ids: string[], status: "removing" | "removed" | "absent" | undefined) =>
    setState("disconnecting", (current) => ({
      ...current,
      ...Object.fromEntries(ids.map((id) => [id, status])),
    }))

  const integration = (item: ProviderItem) => {
    const id = item.integrationID ?? item.id

    return integrations.list().find((entry) => entry.id === id)
  }

  const connect = (provider?: string) => {
    // The list stays as it was while the dialog connects, so a new sign-in that briefly changes the
    // catalog can't flash rows behind the dialog.
    setState("held", available())
    providerConnect.select(provider)
    void dialog.show(
      () => (
        <DialogConnectProvider
          directory={props.directory}
          defaultLocation={props.directory === undefined}
          controller={providerConnect}
          onConnected={(providerID) => {
            setState("disconnecting", providerID, undefined)
          }}
        />
      ),
      () =>
        void accountActions
          .refresh()
          .catch(() => undefined)
          .finally(() => setState("held", undefined)),
    )
  }

  const available = createMemo(() => {
    if (state.held) return state.held
    const connected = providers.connected()
    return connected
  })

  createEffect(() => {
    const ids = new Set(available().map((item) => item.id))
    Object.entries(state.disconnecting).forEach(([id, status]) => {
      if ((status === "removing" || status === "removed") && !ids.has(id)) {
        setState("disconnecting", id, "absent")

        return
      }

      if (status === "absent" && ids.has(id)) setState("disconnecting", id, undefined)
    })
  })

  const connected = createMemo(() => available().filter((item) => !state.disconnecting[item.id]))

  // Providers the member added or connected with their own key are kept apart from the organization's.
  const scopes = useCredentialScopes(() =>
    connected()
      .map((item) => item.id)
      .join(),
  )
  const mine = createMemo(() => connected().filter((item) => scopes.personal(item.id, item.integrationID)))
  const organization = createMemo(() => connected().filter((item) => scopes.organization(item.id, item.integrationID)))
  const global = createMemo(() => connected().filter((item) => scopes.global(item.id, item.integrationID)))

  // The custom providers the member defined, for editing; the rest of "My providers" are built-in ones with their key.
  const [custom, { refetch: refetchCustom }] = createResource(
    () =>
      connected()
        .map((item) => item.id)
        .join(),
    () => serverSdk.api.credential.customProvider.list().catch(() => [] as PersonalProvider[]),
    { initialValue: [] as PersonalProvider[] },
  )
  const customOf = (item: ProviderItem) => (custom.latest ?? []).find((entry) => entry.providerID === item.id)

  const customDialog = (provider?: PersonalProvider) =>
    void dialog.show(() => (
      <DialogPersonalProvider
        provider={provider}
        onSaved={() => {
          void refetchCustom()
          void accountActions.refresh().catch(() => undefined)
        }}
      />
    ))

  // Providers a platform admin defined for every organization; only platform admins can list and remove them.
  const [globalCustom, { refetch: refetchGlobal }] = createResource(
    () =>
      identity?.session.admin
        ? global()
            .map((item) => item.id)
            .join()
        : undefined,
    () => serverSdk.api.credential.globalProvider.list().catch(() => []),
    { initialValue: [] },
  )
  const globalCustomOf = (item: ProviderItem) => (globalCustom.latest ?? []).find((entry) => entry.id === item.id)
  const removeGlobal = async (provider: { id: string; name: string }) => {
    try {
      await serverSdk.api.credential.globalProvider.remove({ providerID: provider.id })
      void refetchGlobal()
      void accountActions.refresh().catch(() => undefined)
    } catch (err) {
      showToast({
        variant: "error",
        title: language.t("common.requestFailed"),
        description: formatServerError(err, language.t),
      })
    }
  }

  // Copies a member's own provider, with their key, into their organization or into every organization. The copy is
  // independent: the personal one stays until the member removes it. An existing provider of the same ID is not replaced.
  const copyProvider = async (provider: PersonalProvider, target: "organization" | "global") => {
    // The catalog has one provider per ID and the organization's wins over a global one, so a copy that shares an ID
    // with either would be hidden or would hide the other.
    const taken = scopes.organization(provider.id) || connected().some((item) => item.id === provider.id)
    if (taken)
      return showToast({
        variant: "error",
        title: language.t("settings.providers.personal.copyTaken", { id: provider.id }),
      })
    try {
      const own = (await serverSdk.api.credential.list()).filter(
        (entry) => entry.integrationID === provider.providerID && entry.scope === "personal",
      )
      const value = (own.find((entry) => entry.active) ?? own.at(-1))?.value
      // Without a key the copy would not be connected, so it would not show up anywhere.
      if (value?.type !== "key")
        return showToast({ variant: "error", title: language.t("settings.providers.personal.copyNoKey") })
      const body = {
        name: provider.name,
        baseURL: provider.baseURL,
        models: [...provider.models],
        headers: provider.headers,
        names: provider.names,
        key: value.key,
      }
      if (target === "global") await serverSdk.api.credential.globalProvider.save({ providerID: provider.id, ...body })
      else
        await accountFetch({
          url: identity!.server.http.url,
          password: identity!.server.http.password,
          path: `/api/organization/${encodeURIComponent(identity!.session.organizationID!)}/provider/${encodeURIComponent(provider.id)}`,
          method: "PUT",
          body,
        })
      showToast({
        variant: "success",
        title: language.t(
          target === "global"
            ? "settings.providers.personal.copiedGlobal"
            : "settings.providers.personal.copiedOrganization",
          { name: provider.name },
        ),
      })
      void accountActions.refresh().catch(() => undefined)
    } catch (err) {
      showToast({
        variant: "error",
        title: language.t("common.requestFailed"),
        description: formatServerError(err, language.t),
      })
    }
  }

  // Connection state comes from the integration list like the TUI: credential
  // connections mean an API key or OAuth grant, env connections mean detected
  // environment variables, and a connectionless integration is config-provided.
  const source = (item: ProviderItem): ProviderSource | undefined => {
    const current = integration(item)
    const credential = current?.connections.find((connection) => connection.type === "credential")

    if (credential) return credential.method === "oauth" ? "account" : "api"

    if (current?.connections.some((connection) => connection.type === "env")) return "env"

    if (current) return "config"

    if (!("source" in item)) return
    const value = item.source

    if (value === "env" || value === "api" || value === "config" || value === "custom") return value

    return
  }

  const type = (item: ProviderItem) => {
    const current = source(item)

    if (current === "env") return language.t("settings.providers.tag.environment")

    if (current === "api") return language.t("provider.connect.method.apiKey")

    if (current === "account") return language.t("settings.providers.tag.account")

    if (current === "config") return language.t("settings.providers.tag.config")

    if (current === "custom") return language.t("settings.providers.tag.custom")

    return language.t("settings.providers.tag.other")
  }

  const canDisconnect = (item: ProviderItem) => {
    const current = integration(item)

    if (current) return current.connections.some((connection) => connection.type === "credential")
    const currentSource = source(item)

    return currentSource !== "env" && currentSource !== "config"
  }

  const canManageAccounts = (item: ProviderItem) => providerAccounts(integration(item)).length > 0

  const disconnect = async (item: ProviderItem, name: string) => {
    if (state.disconnecting[item.id]) return
    const ids = [item.id]
    updateDisconnecting(ids, "removing")
    const location = props.directory ? { directory: props.directory } : undefined
    // A provider the member defined is removed with its key; there is no connection left to keep.
    if (isPersonalProvider(item.id)) {
      await serverSdk.api.credential.customProvider
        .remove({ providerID: item.id.split(".").slice(2).join(".") })
        .then(() => updateDisconnecting(ids, "removed"))
        .catch((err) => {
          updateDisconnecting(ids, undefined)
          showToast({ title: language.t("common.requestFailed"), description: formatServerError(err, language.t) })
        })
      return
    }
    await serverSdk.api.integration
      .get({ integrationID: item.integrationID ?? item.id, location })
      .then(async (integration) => {
        const credentials = integration.data?.connections.filter((item) => item.type === "credential") ?? []

        if (credentials.length === 0) {
          showToast({
            title: language.t("common.requestFailed"),
            description: language.t("provider.disconnect.toast.noCredentials.description", { provider: name }),
          })

          return
        }

        await Promise.all(
          credentials.map((credential) =>
            identity && isGlobalCredential(credential.id)
              ? removeUserCredential(identity.server, globalCredentialIntegration(credential.id))
              : serverSdk.api.credential.remove({ credentialID: credential.id }),
          ),
        )
        updateDisconnecting(ids, "removed")
        showToast({
          variant: "success",
          icon: "circle-check",
          title: language.t("provider.disconnect.toast.disconnected.title", { provider: name }),
          description: language.t("provider.disconnect.toast.disconnected.description", { provider: name }),
        })
      })
      .catch((err) => {
        updateDisconnecting(ids, undefined)
        const message = formatServerError(err, language.t)
        showToast({
          title: language.t("common.requestFailed"),
          description: language.tDynamic("provider.disconnect.toast.failed.description", message, { provider: name }),
        })
      })
  }

  const activate = async (provider: ProviderItem, providerName: string, account: ProviderAccount) => {
    if (activeProviderAccount(integration(provider))?.id === account.id) return
    setState({ credentialID: account.id, held: available() })
    await accountActions.activate({
      integrationID: provider.integrationID ?? provider.id,
      provider: providerName,
      account,
    })
    setState({ credentialID: undefined, held: undefined })
  }

  const remove = async (provider: ProviderItem, providerName: string, account: ProviderAccount) => {
    setState({ credentialID: account.id, held: available() })
    await accountActions.remove({
      integrationID: provider.integrationID ?? provider.id,
      provider: providerName,
      account,
      final: providerAccounts(integration(provider)).length === 1,
    })
    setState({ credentialID: undefined, held: undefined })
  }

  function AccountMenu(menuProps: { provider: ProviderItem; name?: string }) {
    const accounts = () => providerAccounts(integration(menuProps.provider))
    const active = () => activeProviderAccount(integration(menuProps.provider))
    const name = () => menuProps.name ?? menuProps.provider.name
    const renaming = () => accounts().find((account) => account.id === state.renaming)

    return (
      <Show
        when={renaming()}
        fallback={
          <AccountMenuTrigger provider={menuProps.provider} name={name()} accounts={accounts()} active={active()} />
        }
      >
        {(account) => (
          <AccountNameInput
            value={account().label}
            class="settings-provider-account-input"
            onSave={(label) => accountActions.rename(account(), label)}
            onClose={() => setState("renaming", undefined)}
          />
        )}
      </Show>
    )
  }

  function AccountMenuTrigger(menuProps: {
    provider: ProviderItem
    name: string
    accounts: ProviderAccount[]
    active: ProviderAccount | undefined
  }) {
    const accounts = () => menuProps.accounts
    const active = () => menuProps.active
    const name = () => menuProps.name

    return (
      <div class="settings-provider-account-actions">
        <Menu placement="bottom-end" gutter={6}>
          <Menu.Trigger
            as={Button}
            size="normal"
            variant="ghost-muted"
            class="settings-provider-account-trigger"
            aria-label={language.t("settings.providers.account.manage", { provider: name() })}
          >
            <span>{active()?.label}</span>
            <Icon name="chevron-down" size="small" />
          </Menu.Trigger>
          <Menu.Portal>
            <Menu.Content class="settings-provider-account-menu" onEscapeKeyDown={(event) => event.stopPropagation()}>
              <Menu.Group>
                <Menu.GroupLabel>{language.t("settings.providers.account.group")}</Menu.GroupLabel>
                <Menu.RadioGroup
                  class="settings-provider-account-list"
                  value={active()?.id}
                  onChange={(credentialID) => {
                    const account = accounts().find((item) => item.id === credentialID)

                    if (account) void activate(menuProps.provider, name(), account)
                  }}
                >
                  <For each={accounts()}>
                    {(account) => (
                      <Menu.RadioItem value={account.id} closeOnSelect disabled={state.credentialID !== undefined}>
                        <span class="settings-provider-account-label">{account.label}</span>
                      </Menu.RadioItem>
                    )}
                  </For>
                </Menu.RadioGroup>
              </Menu.Group>
              <Menu.Separator />
              <Menu.Item disabled={state.credentialID !== undefined} onSelect={() => connect(menuProps.provider.id)}>
                <Icon name="plus" size="small" class="shrink-0" />
                {language.t("settings.providers.account.add")}
              </Menu.Item>
            </Menu.Content>
          </Menu.Portal>
        </Menu>
        <Menu placement="bottom-end" gutter={6}>
          <Menu.Trigger
            as={IconButton}
            variant="ghost-muted"
            size="large"
            icon={<Icon name="outline-dots" />}
            disabled={state.credentialID !== undefined || !active()}
            aria-label={language.t("dialog.provider.accounts.options", { account: active()?.label ?? "" })}
          />
          <Menu.Portal>
            <Menu.Content onCloseAutoFocus={(event) => state.renaming && event.preventDefault()}>
              {/* A key for every organization lives in the shared store under a fixed label. */}
              <Show when={!isGlobalCredential(active()?.id ?? "")}>
                <Menu.Item onSelect={() => setState("renaming", active()?.id)}>{language.t("common.rename")}</Menu.Item>
              </Show>
              <Menu.Item
                onSelect={() => {
                  const account = active()

                  if (account) void remove(menuProps.provider, name(), account)
                }}
              >
                {language.t("dialog.provider.accounts.remove")}
              </Menu.Item>
            </Menu.Content>
          </Menu.Portal>
        </Menu>
      </div>
    )
  }

  function ConnectedSection(sectionProps: {
    scope: "personal" | "organization" | "global"
    title: string
    description: string
    empty: string
    items: ProviderItem[]
    action?: JSX.Element
  }) {
    return (
      <div class="settings-section" data-component="connected-providers-section" data-scope={sectionProps.scope}>
        <div class="settings-section-heading">
          <h3 class="settings-section-title">{sectionProps.title}</h3>
          {sectionProps.action}
        </div>
        <span class="text-11-regular text-v2-text-text-muted">{sectionProps.description}</span>
        <SettingsList variant="catalog">
          <Show
            when={sectionProps.items.length > 0}
            fallback={<div class="settings-provider-empty">{sectionProps.empty}</div>}
          >
            <For each={sectionProps.items}>
              {(item) => {
                return (
                  <div class="settings-provider-row group">
                    <div class="settings-provider-lead">
                      <ProviderModelIcon provider={item} class="settings-provider-icon shrink-0" />

                      <div class="settings-provider-main">
                        <span class="settings-provider-name truncate">{item.name}</span>
                        <Badge>{type(item)}</Badge>
                        <Show when={customOf(item)}>
                          {(provider) => (
                            <Menu placement="bottom-start" gutter={6}>
                              <Menu.Trigger
                                as={IconButton}
                                variant="ghost-muted"
                                size="large"
                                icon={<Icon name="outline-dots" />}
                                aria-label={language.t("settings.providers.personal.more")}
                              />
                              <Menu.Portal>
                                <Menu.Content>
                                  <Menu.Item onSelect={() => customDialog(provider())}>
                                    {language.t("settings.providers.personal.edit")}
                                  </Menu.Item>
                                  <Show when={identity?.session.organizationAdmin && identity.session.organizationID}>
                                    <Menu.Item onSelect={() => void copyProvider(provider(), "organization")}>
                                      {language.t("settings.providers.personal.copyOrganization")}
                                    </Menu.Item>
                                  </Show>
                                  <Show when={identity?.session.admin}>
                                    <Menu.Item onSelect={() => void copyProvider(provider(), "global")}>
                                      {language.t("settings.providers.personal.copyGlobal")}
                                    </Menu.Item>
                                  </Show>
                                </Menu.Content>
                              </Menu.Portal>
                            </Menu>
                          )}
                        </Show>
                      </div>
                    </div>
                    <Show
                      when={!globalCustomOf(item)}
                      fallback={
                        <Button
                          size="normal"
                          variant="ghost-muted"
                          onClick={() => void removeGlobal(globalCustomOf(item)!)}
                        >
                          {language.t("common.delete")}
                        </Button>
                      }
                    >
                      <Show
                        when={canManageAccounts(item)}
                        fallback={
                          <Show
                            when={canDisconnect(item)}
                            fallback={
                              <Show
                                when={globalCustomOf(item)}
                                fallback={
                                  <span class="settings-provider-env-hint">
                                    {language.t("settings.providers.connected.environmentDescription")}
                                  </span>
                                }
                              >
                                {(provider) => (
                                  <Button
                                    size="normal"
                                    variant="ghost-muted"
                                    onClick={() => void removeGlobal(provider())}
                                  >
                                    {language.t("common.delete")}
                                  </Button>
                                )}
                              </Show>
                            }
                          >
                            <Button
                              size="normal"
                              variant="ghost-muted"
                              onClick={() => void disconnect(item, item.name)}
                            >
                              {language.t("common.disconnect")}
                            </Button>
                          </Show>
                        }
                      >
                        <AccountMenu provider={item} />
                      </Show>
                    </Show>
                  </div>
                )
              }}
            </For>
          </Show>
        </SettingsList>
      </div>
    )
  }

  return (
    <>
      <div class="settings-tab-header">
        <div class="settings-tab-header-row">
          <div class="flex min-w-0 flex-col gap-1">
            <h2 class="settings-tab-title">{language.t("settings.providers.title")}</h2>
            <span class="text-11-regular text-v2-text-text-muted">{language.t("settings.providers.description")}</span>
          </div>
          <div class="settings-tab-header-actions">{props.headerAction}</div>
        </div>
      </div>

      <div class="settings-tab-body settings-tab-body--sectioned settings-providers">
        <ConnectedSection
          scope="personal"
          title={language.t("settings.providers.section.personal")}
          description={language.t("settings.providers.section.personal.description")}
          empty={language.t("settings.providers.personal.empty")}
          items={mine()}
          action={
            <Menu placement="bottom-end" gutter={6}>
              <Menu.Trigger
                as={Button}
                size="normal"
                variant="neutral"
                icon="plus"
                aria-label={language.t("settings.providers.personal.menu.label")}
              >
                {language.t("settings.providers.personal.menu.label")}
              </Menu.Trigger>
              <Menu.Portal>
                <Menu.Content>
                  <Menu.Item onSelect={() => customDialog()}>
                    {language.t("settings.providers.personal.menu.custom")}
                  </Menu.Item>
                </Menu.Content>
              </Menu.Portal>
            </Menu>
          }
        />
        <ConnectedSection
          scope="organization"
          title={language.t("settings.providers.section.organization")}
          description={language.t("settings.providers.section.organization.description")}
          empty={language.t("settings.providers.organization.empty")}
          items={organization()}
        />
        <ConnectedSection
          scope="global"
          title={language.t("settings.providers.section.global")}
          description={language.t("settings.providers.section.global.description")}
          empty={language.t("settings.providers.connected.empty")}
          items={global()}
        />
      </div>
    </>
  )
}
