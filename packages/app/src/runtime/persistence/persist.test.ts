import { describe, expect, test } from "bun:test"
import type { PersistenceSyncAPI, PersistenceSyncCallback, SyncStorage } from "@solid-primitives/storage"
import { createRoot } from "solid-js"
import { createStore } from "solid-js/store"
import { flushPersisted, persistStore } from "./persist"

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

type State = { count: number; label: string }

function setup(input: { initial?: string | null; delay?: number; sync?: PersistenceSyncAPI }) {
  const writes: string[] = []

  return createRoot((dispose) => {
    const [store, setStore] = createStore<State>({ count: 0, label: "" })

    const persist = persistStore({
      store,
      setStore,
      name: "state",
      storage: {
        getItem: () => input.initial ?? null,
        setItem: (_key: string, value: string) => {
          writes.push(value)
        },
        removeItem: () => {},
      } satisfies SyncStorage,
      serialize: JSON.stringify,
      deserialize: JSON.parse,
      sync: input.sync,
      delay: input.delay ?? 10,
    })

    return { store, set: persist.setStore, persist, writes, dispose }
  })
}

describe("persistStore", () => {
  test("adopting another storage takes its value and writes there from then on", async () => {
    const value = setup({ initial: JSON.stringify({ count: 1, label: "local" }) })
    const moved: string[] = []
    const remote: SyncStorage = {
      getItem: () => JSON.stringify({ count: 7, label: "server" }),
      setItem: (_key, next) => {
        moved.push(next)
      },
      removeItem: () => {},
    }

    value.persist.adopt(remote)
    expect(value.store).toEqual({ count: 7, label: "server" })

    value.set("count", 8)
    await wait(30)
    expect(value.writes).toEqual([])
    expect(moved).toEqual([JSON.stringify({ count: 8, label: "server" })])
    value.dispose()
  })

  test("adopting keeps a change the user already made and sends it to the new storage", async () => {
    const value = setup({})
    const moved: string[] = []
    const remote: SyncStorage = {
      getItem: () => JSON.stringify({ count: 7, label: "server" }),
      setItem: (_key, next) => {
        moved.push(next)
      },
      removeItem: () => {},
    }

    value.set("count", 2)
    value.persist.adopt(remote)
    expect(value.store.count).toBe(2)
    await wait(30)
    expect(moved).toEqual([JSON.stringify({ count: 2, label: "" })])
    value.dispose()
  })

  test("marks the store dirty on set and writes once after the delay", async () => {
    const value = setup({})
    value.set("count", 1)
    value.set("count", 2)
    value.set("label", "a")
    expect(value.store.count).toBe(2)
    expect(value.writes).toEqual([])
    await wait(30)
    expect(value.writes).toEqual([JSON.stringify({ count: 2, label: "a" })])
    value.dispose()
  })

  test("skips the write when the serialized value did not change", () => {
    const value = setup({ delay: 10_000 })
    value.set("count", 1)
    value.persist.flush()
    value.set("count", 1)
    value.persist.flush()
    expect(value.writes).toHaveLength(1)
    value.dispose()
  })

  test("hydrates synchronously from sync storage without writing back", () => {
    const value = setup({ initial: JSON.stringify({ count: 5, label: "saved" }), delay: 10_000 })
    expect(value.store).toEqual({ count: 5, label: "saved" })
    value.persist.flush()
    expect(value.writes).toEqual([])
    value.dispose()
  })

  test("applies another window's value when clean and ignores it while dirty", () => {
    const listeners: PersistenceSyncCallback[] = []
    const sent: string[] = []

    const value = setup({
      delay: 10_000,
      sync: [(subscriber) => listeners.push(subscriber), (_key, next) => sent.push(String(next))],
    })

    listeners[0]!({ key: "state", newValue: JSON.stringify({ count: 3, label: "remote" }), timeStamp: 0 })
    expect(value.store).toEqual({ count: 3, label: "remote" })
    value.set("label", "local")
    listeners[0]!({ key: "state", newValue: JSON.stringify({ count: 4, label: "remote-2" }), timeStamp: 0 })
    expect(value.store).toEqual({ count: 3, label: "local" })
    value.persist.flush()
    expect(sent).toEqual([JSON.stringify({ count: 3, label: "local" })])
    value.dispose()
  })

  test("a remote value arriving during a no-op local set is adopted when the save finds no change", () => {
    const listeners: PersistenceSyncCallback[] = []
    const sent: string[] = []

    const value = setup({
      delay: 10_000,
      sync: [(subscriber) => listeners.push(subscriber), (_key, next) => sent.push(String(next))],
    })

    value.set("count", 1)
    value.persist.flush()
    // Setting the same value again marks the store dirty without changing it.
    value.set("count", 1)
    listeners[0]!({ key: "state", newValue: JSON.stringify({ count: 1, label: "remote" }), timeStamp: 0 })
    expect(value.store.label).toBe("")
    value.persist.flush()
    expect(value.store).toEqual({ count: 1, label: "remote" })
    expect(value.writes).toHaveLength(1)
    expect(sent).toHaveLength(1)
    // A later save must not consider the adopted value a local change.
    value.set("count", 1)
    value.persist.flush()
    expect(value.writes).toHaveLength(1)
    value.dispose()
  })

  test("a remote revert to the saved value during a no-op local set clears an earlier held change", () => {
    const listeners: PersistenceSyncCallback[] = []
    const value = setup({ delay: 10_000, sync: [(subscriber) => listeners.push(subscriber), () => {}] })
    value.set("label", "saved")
    value.persist.flush()
    value.set("label", "saved")
    listeners[0]!({ key: "state", newValue: JSON.stringify({ count: 0, label: "changed" }), timeStamp: 0 })
    listeners[0]!({ key: "state", newValue: JSON.stringify({ count: 0, label: "saved" }), timeStamp: 0 })
    value.persist.flush()
    expect(value.store).toEqual({ count: 0, label: "saved" })
    expect(value.writes).toHaveLength(1)
    value.dispose()
  })

  test("a remote value arriving during a real local change is dropped in favour of the local one", () => {
    const listeners: PersistenceSyncCallback[] = []
    const value = setup({ delay: 10_000, sync: [(subscriber) => listeners.push(subscriber), () => {}] })
    value.set("count", 1)
    listeners[0]!({ key: "state", newValue: JSON.stringify({ count: 9, label: "remote" }), timeStamp: 0 })
    value.persist.flush()
    expect(value.store).toEqual({ count: 1, label: "" })
    expect(value.writes).toEqual([JSON.stringify({ count: 1, label: "" })])
    value.dispose()
  })

  test("disposing the owner and flushPersisted both save pending changes", () => {
    const first = setup({ delay: 10_000 })
    first.set("count", 1)
    first.dispose()
    expect(first.writes).toHaveLength(1)

    const second = setup({ delay: 10_000 })
    second.set("count", 2)
    flushPersisted()
    expect(second.writes).toEqual([JSON.stringify({ count: 2, label: "" })])
    second.dispose()
    expect(second.writes).toHaveLength(1)
  })
})
