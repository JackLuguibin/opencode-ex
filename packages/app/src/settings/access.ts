import { useAccountOptional } from "@/identity/gate"
import type { SettingsRootTab } from "./surface"

/**
 * Which settings pages the signed-in account may open. A platform admin, and a server without accounts, sees every
 * page; ordinary members see the pages their organization's admin enabled.
 */
export function useSettingsAccess() {
  const account = useAccountOptional()
  const pages = () => (account && !account.session.admin ? account.session.settingsPages : undefined)

  return {
    restricted: () => pages() !== undefined,
    allows: (tab: string) => pages()?.includes(tab) ?? true,
    /** Where a restricted member lands when asked for a page they can't open. */
    // The server only stores page names the settings know.
    fallback: () => (pages()?.[0] ?? "providers") as SettingsRootTab,
  }
}
