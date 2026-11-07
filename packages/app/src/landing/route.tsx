import { useNavigate } from "@solidjs/router"
import { createEffect } from "solid-js"
import { useAccountOptional } from "@/identity/gate"
import { useLanguage } from "@/runtime/i18n/language"
import { persistLanding } from "./seen"
import { LandingView } from "./view"
import { usePublicOrganizations } from "./organizations"

/** The start page for a signed-in user. Opening it is what marks it as seen. */
export function LandingPage() {
  const language = useLanguage()
  const navigate = useNavigate()
  const account = useAccountOptional()
  const [, setState, , ready] = persistLanding()
  const organizations = usePublicOrganizations(() => account?.server)

  createEffect(() => {
    if (ready()) setState("seen", true)
  })

  return (
    <div class="flex min-h-0 flex-1 flex-col bg-v2-background-bg-base">
      <LandingView
        organizations={organizations()}
        action={{ label: language.t("landing.cta.enter"), onClick: () => navigate("/") }}
      />
    </div>
  )
}
