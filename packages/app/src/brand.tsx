import { Show } from "solid-js"
import { Wordmark } from "@opencode/ui/wordmark"
import { appTitle, renamed } from "@/app-title"

/** The OpenCode wordmark, or the deployment's own product name as text when it has one. */
export function Brand(props: { fade?: boolean; muted?: boolean }) {
  return (
    <Show when={renamed} fallback={<Wordmark fade={props.fade} muted={props.muted} />}>
      <span class="block truncate text-center text-[28px] font-semibold leading-tight text-v2-text-text-base">
        {appTitle}
      </span>
    </Show>
  )
}
