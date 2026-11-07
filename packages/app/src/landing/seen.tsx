import { Schema } from "effect"
import { useLocation, useNavigate } from "@solidjs/router"
import { createEffect } from "solid-js"
import { Persistence } from "@/runtime/persistence/schema"
import { Persist, persisted } from "@/runtime/persistence/storage"
import { shouldShowLanding } from "./redirect"

const LandingState = Persistence.struct({ seen: Schema.Boolean })

// Per account, so a new account starts on the start page in any browser.
export const persistLanding = () => persisted(Persist.user("overview.seen"), LandingState, { seen: false })

/** Sends a user who has not seen the start page to it once, after sign-in. */
export function LandingRedirect() {
  const location = useLocation()
  const navigate = useNavigate()
  const [state, , , ready] = persistLanding()
  let checked = false

  createEffect(() => {
    if (checked || !ready()) return
    checked = true
    if (shouldShowLanding({ seen: state.seen, pathname: location.pathname })) navigate("/overview", { replace: true })
  })

  return null
}
