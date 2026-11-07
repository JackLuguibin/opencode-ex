/** A user who has not seen the start page is sent to it once, when the app opens on `/` after sign-in. */
export function shouldShowLanding(input: { seen: boolean; pathname: string }) {
  return !input.seen && input.pathname === "/"
}
