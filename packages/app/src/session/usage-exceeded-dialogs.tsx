import { useWorkspaceLocation } from "@/workspaces/location"
import { Persist, persisted } from "@/runtime/persistence/storage"
import type { SessionStepFailed } from "@opencode/client/promise"
import { onCleanup } from "solid-js"
import { Schema } from "effect"
import { Persistence } from "@/runtime/persistence/schema"
import { useSessionLayout } from "./session-layout"
import { useDialog } from "@opencode/ui/context"

const GO_UPSELL_FREE_TIER_LAST_SEEN_AT = "go_upsell_last_seen_at"

const GO_UPSELL_FREE_TIER_DONT_SHOW = "go_upsell_dont_show"

const GO_UPSELL_ACCOUNT_RATE_LIMIT_LAST_SEEN_AT = "go_upsell_account_rate_limit_last_seen_at"

const GO_UPSELL_ACCOUNT_RATE_LIMIT_DONT_SHOW = "go_upsell_account_rate_limit_dont_show"

const CHATGPT_USAGE_LIMIT_WINDOW = 86_400_000 // 24 hrs

export function isChatGPTUsageLimit(error: SessionStepFailed["data"]["error"]) {
  return (
    error.message ===
    "ChatGPT usage limit reached. Try again after your allowance resets; check ChatGPT Settings → Usage for details."
  )
}

export const GoUpsellState = Persistence.struct({
  [GO_UPSELL_FREE_TIER_LAST_SEEN_AT]: Schema.NullOr(Schema.Finite),
  [GO_UPSELL_FREE_TIER_DONT_SHOW]: Schema.NullOr(Schema.Finite),
  [GO_UPSELL_ACCOUNT_RATE_LIMIT_LAST_SEEN_AT]: Schema.NullOr(Schema.Finite),
  [GO_UPSELL_ACCOUNT_RATE_LIMIT_DONT_SHOW]: Schema.NullOr(Schema.Finite),
})

export function useUsageExceededDialogs() {
  const sdk = useWorkspaceLocation()
  const dialog = useDialog()
  const { params } = useSessionLayout()

  const [chatgptUsageLimit, setChatGPTUsageLimit] = persisted(
    Persist.global("chatgpt-usage-limit"),
    Persistence.struct({ lastSeenAt: Schema.NullOr(Schema.Finite) }),
    { lastSeenAt: null },
  )

  onCleanup(
    sdk().event.on("session.step.failed", (evt) => {
      if (evt.data.sessionID !== params.id || dialog.active) return
      const error = evt.data.error

      // Official Go subscribe and model-connect dialogs are omitted. The transcript notice stays.
      if (error.type === "provider.free-limit") return

      if (!isChatGPTUsageLimit(error)) return

      if (chatgptUsageLimit.lastSeenAt && Date.now() - chatgptUsageLimit.lastSeenAt < CHATGPT_USAGE_LIMIT_WINDOW) return

      void import("@/providers/connect/chatgpt-usage-limit").then((usage) => {
        if (dialog.active) return
        setChatGPTUsageLimit("lastSeenAt", Date.now())
        dialog.show(() => <usage.DialogChatGPTUsageLimit />)
      })
    }),
  )
}
