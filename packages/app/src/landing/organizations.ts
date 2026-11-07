import { createResource, type Accessor } from "solid-js"
import { accountFetch, type AccountPublicOrganization } from "@/identity/api"
import type { ServerConnection } from "@/runtime/server/registry"

/** The organizations anyone may see, or undefined while they load. A failure shows an empty list, not an error. */
export function usePublicOrganizations(server: Accessor<ServerConnection.Http | undefined>) {
  const [organizations] = createResource(
    () => server()?.http.url ?? false,
    (url) =>
      accountFetch<AccountPublicOrganization[]>({ url, path: "/api/auth/organizations/public" }).catch(
        () => [] as AccountPublicOrganization[],
      ),
  )

  return () => (organizations.state === "ready" || organizations.state === "refreshing" ? organizations.latest : undefined)
}
