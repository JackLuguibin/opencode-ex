import { createMemo, createResource } from "solid-js"
import { useServerSDK } from "@/runtime/server/client"

const PERSONAL = "personal."

/** A provider a member added for themselves has an ID that says so. */
export const isPersonalProvider = (providerID: string) => providerID.startsWith(PERSONAL)

/**
 * Whose each provider is. The server says which ones the organization configured and which the member connected;
 * everything else comes from the server's own environment or configuration and is global. A provider can be in more
 * than one place, for example an organization's key next to the member's own.
 */
export function useCredentialScopes(refetchOn: () => unknown) {
  const sdk = useServerSDK()
  const [scopes] = createResource(refetchOn, () => sdk.api.credential.scopes.get().catch(() => undefined), {
    initialValue: undefined,
  })
  const organization = createMemo(() => new Set(scopes.latest?.organization ?? []))
  const personal = createMemo(() => new Set(scopes.latest?.personal ?? []))
  const key = (providerID: string, integrationID?: string) => integrationID ?? providerID
  return {
    /** False until the server has answered, so nothing is labelled global just because the answer is missing. */
    ready: () => scopes.latest !== undefined,
    /** Under "My providers": the member defined it, or connected it with their own key. */
    personal: (providerID: string, integrationID?: string) =>
      isPersonalProvider(providerID) || personal().has(key(providerID, integrationID)),
    /** Under "Organization providers": the organization configured it. */
    organization: (providerID: string, integrationID?: string) =>
      !isPersonalProvider(providerID) && organization().has(key(providerID, integrationID)),
    /** Under "Global providers": nothing the organization or the member set up, so the server provides it. */
    global: (providerID: string, integrationID?: string) =>
      !isPersonalProvider(providerID) &&
      !organization().has(key(providerID, integrationID)) &&
      !personal().has(key(providerID, integrationID)),
  }
}
