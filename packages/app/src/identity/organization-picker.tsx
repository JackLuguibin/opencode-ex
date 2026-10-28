import { For, Show } from "solid-js"
import { useLanguage } from "@/runtime/i18n/language"
import type { AccountOrganization } from "./api"

/** Checkboxes for the organizations something is opened to, with a shortcut for all of them. */
export function OrganizationPicker(props: {
  organizations: readonly AccountOrganization[]
  selected: readonly string[]
  onChange: (next: string[]) => void
}) {
  const language = useLanguage()
  const toggle = (id: string) =>
    props.onChange(props.selected.includes(id) ? props.selected.filter((item) => item !== id) : [...props.selected, id])

  return (
    <div class="flex flex-wrap items-center gap-3 text-13-regular">
      <Show
        when={props.organizations.length > 0}
        fallback={<span class="text-v2-text-text-muted">{language.t("account.packages.noOrganizations")}</span>}
      >
        <label class="flex items-center gap-1">
          <input
            type="checkbox"
            checked={props.selected.length === props.organizations.length}
            onChange={(event) => props.onChange(event.currentTarget.checked ? props.organizations.map((item) => item.id) : [])}
          />
          {language.t("account.packages.all")}
        </label>
        <For each={props.organizations}>
          {(organization) => (
            <label class="flex items-center gap-1">
              <input type="checkbox" checked={props.selected.includes(organization.id)} onChange={() => toggle(organization.id)} />
              {organization.name}
            </label>
          )}
        </For>
      </Show>
    </div>
  )
}
