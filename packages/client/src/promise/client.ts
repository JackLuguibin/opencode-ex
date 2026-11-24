export * as OpenCode from "./client.js"

import { SharedEvents } from "../shared-events.js"
import { OpenCode } from "./generated/index.js"
import { makeRpc } from "./rpc.js"

export type { RequestOptions } from "./generated/client.js"

export type ClientOptions = OpenCode.ClientOptions & { sharedEventsWithoutFragments?: boolean }

export function make(options: ClientOptions) {
  const raw = OpenCode.make(options)
  const events = SharedEvents.make((signal, onActivity, headers) =>
    raw.event.subscribe(options.sharedEventsWithoutFragments ? { streamSessionID: "" } : undefined, {
      signal,
      onActivity,
      headers,
    }),
  )
  return {
    ...raw,
    rpc: Object.assign(makeRpc(raw, events), raw.rpc),
    event: { ...events, subscribeScoped: raw.event.subscribe },
  }
}
