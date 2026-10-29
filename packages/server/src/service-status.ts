export * as Status from "./service-status"

import { Effect, Ref } from "effect"

export type State =
  | { readonly type: "starting" }
  | { readonly type: "ready" }
  /** Still serving, but refusing new sessions while running ones finish ahead of a shutdown. */
  | { readonly type: "draining" }
  | { readonly type: "stopping" }
  | { readonly type: "failed" }

export interface Interface {
  readonly current: Effect.Effect<State>
  readonly ready: Effect.Effect<void>
  readonly fail: Effect.Effect<void>
  readonly beginDraining: Effect.Effect<void>
  readonly beginStopping: Effect.Effect<void>
}

export const make = Effect.fnUntraced(function* (options: { readonly initial?: State } = {}) {
  const current = yield* Ref.make(options.initial ?? ({ type: "starting" } satisfies State))
  const beginStopping = Ref.update(current, (status) =>
    status.type === "stopping" ? status : ({ type: "stopping" } satisfies State),
  )

  return {
    current: Ref.get(current),
    ready: Ref.update(current, (status) => (status.type === "starting" ? ({ type: "ready" } satisfies State) : status)),
    fail: Ref.update(current, (status) => (status.type === "starting" ? ({ type: "failed" } satisfies State) : status)),
    beginDraining: Ref.update(current, (status) => (status.type === "ready" ? ({ type: "draining" } satisfies State) : status)),
    beginStopping,
  } satisfies Interface
})
