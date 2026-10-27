import { Mark } from "@opencode/ui/logo"
import { Show, type JSX } from "solid-js"
import { useLanguage } from "@/runtime/i18n/language"

export function HomeWelcome(props: { project?: string; children?: JSX.Element }) {
  const language = useLanguage()

  return (
    <div class="home-welcome">
      {props.children ?? <Mark class="h-9 w-7 opacity-30" />}
      <h1>
        <Show when={props.project} fallback={language.t("home.welcome")}>
          {(name) => language.t("home.welcomeProject", { name: name() })}
        </Show>
      </h1>
    </div>
  )
}
