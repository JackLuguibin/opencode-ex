import { batch, createEffect, onCleanup } from "solid-js"

type Ref = { providerID: string; modelID: string }
type Preferences = {
  hidden: ReadonlyArray<Ref>
  shown: ReadonlyArray<Ref>
  favorite: ReadonlyArray<Ref>
  recent: ReadonlyArray<Ref>
  default?: Ref
}

/** The part of the global model store that follows the signed-in account. Variants stay with the browser. */
type Store = {
  store: {
    user: ReadonlyArray<Ref & { visibility: "show" | "hide" }>
    recent: ReadonlyArray<Ref>
    favorite: ReadonlyArray<Ref>
  }
  set: (...args: never[]) => void
  ready: { promise?: Promise<unknown> }
}

type Api = {
  credential: {
    modelPreference: {
      get: () => Promise<Preferences>
      update: (input: Preferences) => Promise<Preferences>
    }
  }
}

const ref = (item: Ref): Ref => ({ providerID: item.providerID, modelID: item.modelID })

/**
 * Keeps the member's hidden, shown, favorite and recent models on the server, so they follow the account across
 * browsers. The local store stays the source the pickers read. The first time an account has nothing on the server,
 * what this browser already holds is uploaded; afterwards the server's copy replaces the local one when the server
 * connects, and local changes are sent a moment after the last edit. The most recently used model is also the
 * account's default, which is what a session another member continues runs on when it was started on a model only
 * its previous holder had.
 */
export function createModelPreferenceSync(api: Api, models: Store) {
  const store = models.store
  const set = models.set as unknown as (...args: unknown[]) => void
  let applied = false
  let synced = ""
  let timer: ReturnType<typeof setTimeout> | undefined

  const snapshot = (): Preferences => ({
    hidden: store.user.filter((item) => item.visibility === "hide").map(ref),
    shown: store.user.filter((item) => item.visibility === "show").map(ref),
    favorite: store.favorite.map(ref),
    recent: store.recent.map(ref),
    ...(store.recent[0] ? { default: ref(store.recent[0]) } : {}),
  })
  const empty = (value: Preferences) => !value.hidden.length && !value.shown.length && !value.favorite.length && !value.recent.length

  const push = () => {
    const value = snapshot()
    const key = JSON.stringify(value)
    if (key === synced) return
    void api.credential.modelPreference
      .update(value)
      .then(() => {
        synced = key
      })
      // The next edit tries again; a server that cannot be reached must not interrupt picking a model.
      .catch(() => undefined)
  }

  void (async () => {
    await models.ready.promise
    const remote = await api.credential.modelPreference.get().catch(() => undefined)
    if (!remote) return
    if (empty(remote)) {
      applied = true
      if (!empty(snapshot())) push()
      return
    }
    batch(() => {
      set("user", [
        ...remote.hidden.map((item) => ({ ...ref(item), visibility: "hide" })),
        ...remote.shown.map((item) => ({ ...ref(item), visibility: "show" })),
      ])
      set("recent", remote.recent.map(ref))
      set("favorite", remote.favorite.map(ref))
    })
    synced = JSON.stringify(snapshot())
    applied = true
  })()

  createEffect(() => {
    // Reading the snapshot is what subscribes this effect to every list it covers.
    const key = JSON.stringify(snapshot())
    if (!applied || key === synced) return
    clearTimeout(timer)
    timer = setTimeout(push, 800)
  })
  onCleanup(() => clearTimeout(timer))
}
