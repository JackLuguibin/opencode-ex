/**
 * A new service worker takes over as soon as it installs, so a tab that was already controlled reloads to run the new
 * build. A tab with no controller yet (the first visit) is not reloaded: it is claimed without having run old code.
 * The registration is checked again whenever the tab becomes visible, so a tab left open for days still updates.
 */
export function reloadOnUpdate() {
  const controlled = !!navigator.serviceWorker.controller
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    const worker = navigator.serviceWorker.controller
    if (!controlled || !worker) return
    // Reloading while the worker is still activating can be answered by the build it replaces.
    if (worker.state === "activated") return location.reload()
    worker.addEventListener("statechange", () => worker.state === "activated" && location.reload())
  })
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState !== "visible") return
    void navigator.serviceWorker.getRegistration().then((registration) => registration?.update().catch(() => undefined))
  })
}
