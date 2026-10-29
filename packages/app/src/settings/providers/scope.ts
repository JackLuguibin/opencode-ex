import { createMemo, createResource } from "solid-js"
import { useServerSDK } from "@/runtime/server/client"

type Scope = "personal" | "organization"

const PERSONAL = "personal."

/** A provider a member added for themselves has an ID that says so. */
export const isPersonalProvider = (providerID: string) => providerID.startsWith(PERSONAL)

/**
 * Whose the stored credentials of each integration are. Members only see their own credentials here, so a provider
 * they have no credential for is the organization's (or the server's) to offer; admins also see the shared ones.
 */
export function useCredentialScopes(refetchOn: () => unknown) {
  const sdk = useServerSDK()
  const [entries] = createResource(refetchOn, () => sdk.api.credential.list().catch(() => []), { initialValue: [] })
  const byIntegration = createMemo(() => {
    const map = new Map<string, Set<Scope>>()
    for (const entry of entries.latest ?? []) {
      const scopes = map.get(entry.integrationID) ?? new Set<Scope>()
      scopes.add(entry.scope)
      map.set(entry.integrationID, scopes)
    }
    return map
  })
  const of = (providerID: string, integrationID?: string) => byIntegration().get(integrationID ?? providerID)
  return {
    /** Shown under "My providers": it has the member's own key, or the member defined it. */
    personal: (providerID: string, integrationID?: string) =>
      isPersonalProvider(providerID) || of(providerID, integrationID)?.has("personal") === true,
    /** Shown under "Organization providers": everything the member did not define, unless only their own key connects it. */
    organization: (providerID: string, integrationID?: string) => {
      if (isPersonalProvider(providerID)) return false
      const scopes = of(providerID, integrationID)
      return scopes?.has("organization") === true || scopes?.has("personal") !== true
    },
  }
}
