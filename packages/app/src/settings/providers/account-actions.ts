import { globalCredentialIntegration, isGlobalCredential, removeUserCredential } from "@/identity/credentials"
import { useAccountOptional } from "@/identity/gate"
import { showToast } from "@/shell/notifications/toast"
import { useLanguage } from "@/runtime/i18n/language"
import { useServerSDK } from "@/runtime/server/client"
import { useData } from "@/runtime/server/current"
import { formatServerError } from "@/runtime/server/errors"
import type { ProviderAccount } from "./accounts"

// Shared by the connect dialog and Settings so both switch, rename and remove accounts the same way.
export function useProviderAccountActions(directory: () => string | undefined) {
  const language = useLanguage()
  const sdk = useServerSDK()
  const account = useAccountOptional()
  const data = useData()

  const location = () => {
    const value = directory()

    return value ? { directory: value } : undefined
  }

  const refresh = async () => {
    const ref = location()
    data.location.integration.invalidate(ref)
    data.location.provider.invalidate(ref)
    data.location.model.invalidate(ref)
    await Promise.all([
      data.location.integration.sync(ref),
      data.location.provider.sync(ref),
      data.location.model.sync(ref),
    ])
  }

  const fail = (message: string) => showToast({ title: language.t("common.requestFailed"), description: message })

  const activate = (input: { integrationID: string; provider: string; account: ProviderAccount }) =>
    sdk.api.credential
      .activate({ credentialID: input.account.id })
      .then(refresh)
      .then(() =>
        showToast({
          variant: "success",
          icon: "circle-check",
          title: language.t("settings.providers.account.switched.title", { provider: input.provider }),
          description: language.t("settings.providers.account.switched.description", { account: input.account.label }),
        }),
      )
      .catch((error) => fail(formatServerError(error, language.t)))

  const remove = (input: { integrationID: string; provider: string; account: ProviderAccount; final: boolean }) =>
    (account && isGlobalCredential(input.account.id)
      ? removeUserCredential(account.server, globalCredentialIntegration(input.account.id))
      : sdk.api.credential.remove({ credentialID: input.account.id })
    )
      .then(refresh)
      .then(() =>
        showToast({
          variant: "success",
          icon: "circle-check",
          title: input.final
            ? language.t("provider.disconnect.toast.disconnected.title", { provider: input.provider })
            : language.t("settings.providers.account.removed.title", { account: input.account.label }),
          description: input.final
            ? language.t("provider.disconnect.toast.disconnected.description", { provider: input.provider })
            : language.t("settings.providers.account.removed.description", { provider: input.provider }),
        }),
      )
      .catch((error) => fail(formatServerError(error, language.t)))

  const rename = (account: ProviderAccount, label: string) =>
    sdk.api.credential
      .update({ credentialID: account.id, label })
      .then(refresh)
      .then(() => true)
      .catch((error) => {
        fail(formatServerError(error, language.t))

        return false
      })

  return { refresh, activate, remove, rename }
}
