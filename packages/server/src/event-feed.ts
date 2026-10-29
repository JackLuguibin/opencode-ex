export * as EventFeed from "./event-feed"

import { Bus } from "@opencode/core/bus"
import { Event } from "@opencode/schema/event"
import { isOpenCodeEvent, type OpenCodeEvent } from "@opencode/protocol/groups/event"
import path from "node:path"
import { Cause, Context, Effect, Layer, Queue, Schema, Scope, Stream } from "effect"

export const SubscriberCapacity = 4_096

/**
 * One log of recent events shared by every subscriber, so memory does not grow with the number of users. A client that
 * reconnects with the id of the last event it saw gets what came after it, if the log still reaches back that far.
 */
export const ReplayCapacity = 4_096
export const ReplayBytes = 16 * 1024 * 1024

export class SubscriberOverflowError extends Schema.TaggedError<SubscriberOverflowError>()(
  "EventFeed.SubscriberOverflow",
  { capacity: Schema.Int },
) {}

export class EncodingError extends Schema.TaggedError<EncodingError>()("EventFeed.EncodingError", {
  eventID: Event.ID,
  eventType: Schema.String,
  cause: Schema.Defect(),
}) {}

export type Error = SubscriberOverflowError | EncodingError

type Filter = (event: OpenCodeEvent) => Effect.Effect<boolean>

export interface Interface {
  /** `allow` narrows what this subscriber may see, on top of the requested `types`. */
  readonly subscribe: (
    types?: ReadonlyArray<string>,
    allow?: Filter,
  ) => Effect.Effect<Stream.Stream<string, Error>, never, Scope.Scope>
  /**
   * Like `subscribe`, but first replays the events after `after`, filtered the same way as live ones. `resumed` is false
   * when the log no longer holds `after` (it scrolled out, or this process restarted): the caller missed events it
   * cannot get back and must reload its state.
   */
  readonly resume: (
    after: string,
    types?: ReadonlyArray<string>,
    allow?: Filter,
  ) => Effect.Effect<{ readonly resumed: boolean; readonly stream: Stream.Stream<string, Error> }, never, Scope.Scope>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/server/EventFeed") {}

export function frame(event: OpenCodeEvent) {
  return `data: ${JSON.stringify(event)}\n\n`
}

// The SSE id is the event's own id. server.connected carries none: it is not in the replay log, so a client that kept
// its id could never resume.
function identified(event: OpenCodeEvent) {
  return event.type === "server.connected" ? frame(event) : `id: ${event.id}\n${frame(event)}`
}

export const make = Effect.fn("EventFeed.make")(function* (
  observe: (subscriber: Bus.Subscriber) => Effect.Effect<Bus.Unsubscribe>,
  options?: {
    readonly capacity?: number
    readonly encode?: (event: OpenCodeEvent) => string
    readonly replay?: { readonly events?: number; readonly bytes?: number }
  },
) {
  const capacity = options?.capacity ?? SubscriberCapacity
  const render = options?.encode ?? identified
  const replayEvents = options?.replay?.events ?? ReplayCapacity
  const replayBytes = options?.replay?.bytes ?? ReplayBytes
  const subscribers = new Map<
    Queue.Queue<string, Error>,
    {
      readonly types: ReadonlySet<string> | undefined
      readonly allow: Filter | undefined
      // Entries up to this number were handed to the subscriber by its replay; the live path must not repeat them.
      replayed: number
    }
  >()

  // Numbered in publish order; evicted from the front, so what remains is always a contiguous run.
  const log = new Map<number, { readonly event: OpenCodeEvent; readonly encoded: string }>()
  const numbers = new Map<string, number>()
  let latest = 0
  let oldest = 1
  let bytes = 0

  const remember = (event: OpenCodeEvent, encoded: string) => {
    latest += 1
    log.set(latest, { event, encoded })
    numbers.set(event.id, latest)
    bytes += encoded.length
    while (log.size > replayEvents || (bytes > replayBytes && log.size > 1)) {
      const removed = log.get(oldest)!
      log.delete(oldest)
      numbers.delete(removed.event.id)
      bytes -= removed.encoded.length
      oldest += 1
    }
  }

  const fail = (error: Error) =>
    Effect.sync(() => {
      const current = Array.from(subscribers.keys())
      subscribers.clear()
      for (const subscriber of current) Queue.failCauseUnsafe(subscriber, Cause.fail(error))
    })

  const publish = Effect.fnUntraced(function* (event: Event.Payload) {
    if (!isOpenCodeEvent(event)) return
    // Encoded once for everyone, and kept for reconnecting clients.
    const encoded = yield* Effect.try({
      try: () => render(event),
      catch: (cause) => new EncodingError({ eventID: event.id, eventType: event.type, cause }),
    }).pipe(
      Effect.catch((error) =>
        Effect.logError("Failed to encode public event", {
          eventID: error.eventID,
          eventType: error.eventType,
          cause: error.cause,
        }).pipe(Effect.andThen(fail(error)), Effect.as(undefined)),
      ),
    )
    if (encoded === undefined) return
    remember(event, encoded)
    const number = latest
    for (const [subscriber, filter] of subscribers) {
      if (number <= filter.replayed) continue
      if (filter.types && !filter.types.has(event.type)) continue
      if (filter.allow && !(yield* filter.allow(event))) continue
      if (Queue.offerUnsafe(subscriber, encoded)) continue
      subscribers.delete(subscriber)
      Queue.failCauseUnsafe(subscriber, Cause.fail(new SubscriberOverflowError({ capacity })))
    }
  })

  const unsubscribe = yield* observe(publish)
  yield* Effect.addFinalizer(() => unsubscribe)

  const open = (types: ReadonlyArray<string> | undefined, allow: Filter | undefined, replayed: number) =>
    Effect.acquireRelease(
      Queue.dropping<string, Error>(capacity).pipe(
        Effect.tap((queue) =>
          Effect.sync(() => subscribers.set(queue, { types: types?.length ? new Set(types) : undefined, allow, replayed })),
        ),
      ),
      (queue) => Effect.sync(() => subscribers.delete(queue)).pipe(Effect.andThen(Queue.shutdown(queue)), Effect.asVoid),
    )

  return Service.of({
    subscribe: (types, allow) => open(types, allow, 0).pipe(Effect.map(Stream.fromQueue)),
    resume: (after, types, allow) =>
      Effect.gen(function* () {
        // Registered first but held back from live events; the next step takes what was missed and releases them in one
        // go, so an event published in between is in one or the other, never lost or repeated.
        const queue = yield* open(types, allow, Number.MAX_SAFE_INTEGER)
        const { anchor, missed } = yield* Effect.sync(() => {
          const anchor = numbers.get(after)
          const upTo = latest
          subscribers.get(queue)!.replayed = anchor === undefined ? 0 : upTo
          return {
            anchor,
            missed: anchor === undefined ? [] : Array.from({ length: upTo - anchor }, (_, index) => log.get(anchor + 1 + index)!),
          }
        })
        const wanted = types?.length ? new Set(types) : undefined
        const replay = Stream.fromIterable(missed).pipe(
          Stream.filterEffect((entry) =>
            wanted && !wanted.has(entry.event.type) ? Effect.succeed(false) : allow ? allow(entry.event) : Effect.succeed(true),
          ),
          Stream.map((entry) => entry.encoded),
        )
        return { resumed: anchor !== undefined, stream: replay.pipe(Stream.concat(Stream.fromQueue(queue))) }
      }),
  })
})

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const bus = yield* Bus.Service
    return yield* make(bus.listen)
  }),
)

/** Whether `directory` is `root` or inside it. */
export function within(root: string, directory: string) {
  const relative = path.relative(root, directory)
  return !relative.startsWith("..") && !path.isAbsolute(relative)
}
