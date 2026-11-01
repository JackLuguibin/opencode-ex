/**
 * Offers a waiting service worker to the caller. The worker never takes over on its own, so open tabs keep a complete
 * build; `apply` activates it and reloads the page. The registration is checked again whenever the tab becomes visible,
 * so a tab left open for days still learns about a release.
 */
export function watchUpdate(offer: (apply: () => void) => void) {
  if (!import.meta.env.PROD || !("serviceWorker" in navigator)) return
  let offered = false
  void navigator.serviceWorker.ready.then((registration) => {
    const check = () => {
      const waiting = registration.waiting
      if (!waiting || offered) return
      offered = true
      offer(() => {
        navigator.serviceWorker.addEventListener("controllerchange", () => location.reload(), { once: true })
        waiting.postMessage({ type: "SKIP_WAITING" })
      })
    }
    check()
    registration.addEventListener("updatefound", () =>
      registration.installing?.addEventListener("statechange", (event) => {
        if ((event.target as ServiceWorker).state === "installed") check()
      }),
    )
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") void registration.update().catch(() => undefined)
    })
  })
}
