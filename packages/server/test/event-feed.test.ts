import { describe, expect, test } from "bun:test"
import { Agent } from "@opencode/core/agent"
import { Bus } from "@opencode/core/bus"
import { Credential } from "@opencode/schema/credential"
import { Event } from "@opencode/schema/event"
import { AbsolutePath } from "@opencode/schema/schema"
import { IntegrationID } from "@opencode/schema/integration-id"
import { Deferred, Effect, Exit, Fiber, Option, Schema, Stream } from "effect"
import { it } from "../../core/test/lib/effect"
import { EventFeed } from "../src/event-feed"

const Internal = Bus.ephemeral({ type: "test.internal", schema: { value: Schema.String } })

const event = (id: string): Event.Payload<typeof Agent.Event.Updated> => ({
  id: Event.ID.make(`evt_${id}`),
  created: Date.now(),
  type: Agent.Event.Updated.type,
  data: {},
})

const internal = (value: string): Event.Payload<typeof Internal> => ({
  id: Event.ID.create(),
  created: Date.now(),
  type: Internal.type,
  data: { value },
})

function makeSource() {
  let subscriber: Bus.Subscriber | undefined
  return {
    observe: (next: Bus.Subscriber) =>
      Effect.sync(() => {
        subscriber = next
        return Effect.sync(() => {
          if (subscriber === next) subscriber = undefined
        })
      }),
    publish: (event: Event.Payload) => Effect.suspend(() => (subscriber ? subscriber(event) : Effect.void)),
  }
}

describe("EventFeed", () => {
  test("preserves the public SSE frame encoding", () => {
    const payload = event("wire")
    expect(EventFeed.frame(payload)).toBe(`data: ${JSON.stringify(payload)}\n\n`)
  })

  it.effect("encodes once and delivers the same frame to every subscriber", () =>
    Effect.gen(function* () {
      let encodes = 0
      const source = makeSource()
      const feed = yield* EventFeed.make(source.observe, {
        encode: (event) => {
          encodes += 1
          return event.type
        },
      })
      const first = yield* feed.subscribe()
      const second = yield* feed.subscribe()
      const left = yield* first.pipe(Stream.take(1), Stream.runCollect, Effect.forkScoped)
      const right = yield* second.pipe(Stream.take(1), Stream.runCollect, Effect.forkScoped)

      yield* source.publish(event("example"))

      expect([Array.from(yield* Fiber.join(left)), Array.from(yield* Fiber.join(right))]).toEqual([
        [Agent.Event.Updated.type],
        [Agent.Event.Updated.type],
      ])
      expect(encodes).toBe(1)
    }),
  )

  it.effect("delivers only the requested event types to filtered subscribers", () =>
    Effect.gen(function* () {
      const source = makeSource()
      const feed = yield* EventFeed.make(source.observe, { encode: (event) => event.type })
      const filtered = yield* feed.subscribe([Credential.Event.Switched.type])
      const all = yield* feed.subscribe()
      const left = yield* filtered.pipe(Stream.take(1), Stream.runCollect, Effect.forkScoped)
      const right = yield* all.pipe(Stream.take(2), Stream.runCollect, Effect.forkScoped)

      yield* source.publish(event("ignored"))
      yield* source.publish({
        id: Event.ID.create(),
        created: Date.now(),
        type: Credential.Event.Switched.type,
        data: {
          credentialID: Credential.ID.make("cred_test"),
          integrationID: IntegrationID.make("openai"),
        },
      })

      expect(Array.from(yield* Fiber.join(left))).toEqual([Credential.Event.Switched.type])
      expect(Array.from(yield* Fiber.join(right))).toEqual([Agent.Event.Updated.type, Credential.Event.Switched.type])
    }),
  )

  it.effect("fails only the subscriber that exceeds its lag capacity", () =>
    Effect.gen(function* () {
      const source = makeSource()
      const feed = yield* EventFeed.make(source.observe, {
        capacity: 1,
        encode: (event) => event.id,
      })
      const slow = yield* feed.subscribe()
      const fast = yield* feed.subscribe()
      const first = yield* Deferred.make<void>()
      const second = yield* Deferred.make<void>()
      const received = new Array<string>()
      const fastFiber = yield* fast.pipe(
        Stream.take(3),
        Stream.runForEach((frame) =>
          Effect.sync(() => received.push(frame)).pipe(
            Effect.andThen(
              frame === "evt_one"
                ? Deferred.succeed(first, undefined)
                : frame === "evt_two"
                  ? Deferred.succeed(second, undefined)
                  : Effect.void,
            ),
          ),
        ),
        Effect.forkScoped,
      )

      yield* source.publish(event("one"))
      yield* Deferred.await(first)
      yield* source.publish(event("two"))
      yield* Deferred.await(second)
      yield* source.publish(event("three"))

      yield* Fiber.join(fastFiber)

      const result = yield* slow.pipe(Stream.runCollect, Effect.exit)
      expect(received).toEqual(["evt_one", "evt_two", "evt_three"])
      expect(Exit.isFailure(result)).toBeTrue()
      if (Exit.isSuccess(result)) return
      expect(Option.getOrUndefined(Exit.findErrorOption(result))).toBeInstanceOf(EventFeed.SubscriberOverflowError)
    }),
  )

  it.effect("delivers global credential events to public subscribers", () =>
    Effect.gen(function* () {
      const source = makeSource()
      const feed = yield* EventFeed.make(source.observe, { encode: (event) => event.type })
      const stream = yield* feed.subscribe()
      const received = yield* stream.pipe(Stream.take(1), Stream.runCollect, Effect.forkScoped)

      yield* source.publish({
        id: Event.ID.create(),
        created: Date.now(),
        type: Credential.Event.Switched.type,
        data: {
          credentialID: Credential.ID.make("cred_test"),
          integrationID: IntegrationID.make("openai"),
        },
      })

      expect(Array.from(yield* Fiber.join(received))).toEqual([Credential.Event.Switched.type])
    }),
  )

  it.effect("filters internal events before they consume subscriber capacity", () =>
    Effect.gen(function* () {
      const source = makeSource()
      const feed = yield* EventFeed.make(source.observe, { capacity: 1, encode: (event) => event.type })
      const stream = yield* feed.subscribe()

      yield* source.publish(internal("one"))
      yield* source.publish(internal("two"))
      yield* source.publish(event("public"))

      expect(Array.from(yield* stream.pipe(Stream.take(1), Stream.runCollect))).toEqual([Agent.Event.Updated.type])
    }),
  )

  it.effect("disconnects current subscribers after an encoding failure and continues for later subscribers", () =>
    Effect.gen(function* () {
      const source = makeSource()
      const feed = yield* EventFeed.make(source.observe, {
        encode: (event) => {
          if (event.id === Event.ID.make("evt_bad")) throw new Error("invalid event")
          return event.id
        },
      })
      const current = yield* feed.subscribe()
      const failed = yield* current.pipe(Stream.runCollect, Effect.exit, Effect.forkScoped)

      yield* source.publish(event("bad"))
      const exit = yield* Fiber.join(failed)

      const next = yield* feed.subscribe()
      const received = yield* next.pipe(Stream.take(1), Stream.runCollect, Effect.forkScoped)
      yield* source.publish(event("good"))

      expect(Exit.isFailure(exit)).toBeTrue()
      if (Exit.isSuccess(exit)) return
      expect(Option.getOrUndefined(Exit.findErrorOption(exit))).toBeInstanceOf(EventFeed.EncodingError)
      expect(Array.from(yield* Fiber.join(received))).toEqual(["evt_good"])
    }),
  )

  it.effect("shows a scoped subscriber only the events its filter allows", () =>
    Effect.gen(function* () {
      const source = makeSource()
      const feed = yield* EventFeed.make(source.observe, { encode: (event) => event.id })
      const scoped = yield* feed.subscribe(undefined, (event) =>
        Effect.succeed(!!event.location && EventFeed.within("/data/organizations/a", event.location.directory)),
      )
      const everything = yield* feed.subscribe()
      const left = yield* scoped.pipe(Stream.take(1), Stream.runCollect, Effect.forkScoped)
      const right = yield* everything.pipe(Stream.take(4), Stream.runCollect, Effect.forkScoped)
      const at = (id: string, directory?: string) => ({
        ...event(id),
        ...(directory ? { location: { directory: AbsolutePath.make(directory) } } : {}),
      })

      yield* source.publish(at("global"))
      yield* source.publish(at("other", "/data/organizations/b/project"))
      yield* source.publish(at("sibling", "/data/organizations/ab"))
      yield* source.publish(at("mine", "/data/organizations/a/project"))

      expect(Array.from(yield* Fiber.join(left))).toEqual(["evt_mine"])
      expect(Array.from(yield* Fiber.join(right))).toEqual(["evt_global", "evt_other", "evt_sibling", "evt_mine"])
    }),
  )

  describe("resuming", () => {
    const collect = (stream: Stream.Stream<string, EventFeed.Error>, count: number) =>
      stream.pipe(Stream.take(count), Stream.runCollect, Effect.map((items) => Array.from(items)), Effect.forkScoped)

    it.effect("replays what came after the last event seen, then continues live without repeating", () =>
      Effect.gen(function* () {
        const source = makeSource()
        const feed = yield* EventFeed.make(source.observe, { encode: (event) => event.id })
        for (const id of ["one", "two", "three"]) yield* source.publish(event(id))

        const resumed = yield* feed.resume("evt_one")
        expect(resumed.resumed).toBe(true)
        const received = yield* collect(resumed.stream, 4)
        yield* source.publish(event("four"))
        yield* source.publish(event("five"))

        expect(yield* Fiber.join(received)).toEqual(["evt_two", "evt_three", "evt_four", "evt_five"])
      }),
    )

    it.effect("is resumed with nothing to replay when the client saw the latest event", () =>
      Effect.gen(function* () {
        const source = makeSource()
        const feed = yield* EventFeed.make(source.observe, { encode: (event) => event.id })
        yield* source.publish(event("one"))
        const resumed = yield* feed.resume("evt_one")
        const received = yield* collect(resumed.stream, 1)
        yield* source.publish(event("two"))
        expect([resumed.resumed, yield* Fiber.join(received)]).toEqual([true, ["evt_two"]])
      }),
    )

    it.effect("says it could not resume when the event is unknown or has scrolled out of the log", () =>
      Effect.gen(function* () {
        const source = makeSource()
        const feed = yield* EventFeed.make(source.observe, { encode: (event) => event.id, replay: { events: 2 } })
        for (const id of ["one", "two", "three"]) yield* source.publish(event(id))

        // A restarted process knows none of the old ids; a busy one has dropped the oldest.
        for (const unknown of ["evt_missing", "evt_one"]) {
          const resumed = yield* feed.resume(unknown)
          expect(resumed.resumed).toBe(false)
          const received = yield* collect(resumed.stream, 1)
          yield* source.publish(event(`after_${unknown}`))
          expect(yield* Fiber.join(received)).toEqual([`evt_after_${unknown}`])
        }
        expect((yield* feed.resume("evt_three")).resumed).toBe(false)
      }),
    )

    it.effect("holds the log to its byte budget, always keeping the newest event", () =>
      Effect.gen(function* () {
        const source = makeSource()
        const feed = yield* EventFeed.make(source.observe, {
          encode: (event) => `${event.id}${"x".repeat(100)}`,
          replay: { bytes: 250 },
        })
        for (const id of ["one", "two", "three", "four"]) yield* source.publish(event(id))
        expect((yield* feed.resume("evt_one")).resumed).toBe(false)
        expect((yield* feed.resume("evt_four")).resumed).toBe(true)
      }),
    )

    it.effect("a client starting over gets the latest event as its cursor; one that resumes does not", () =>
      Effect.gen(function* () {
        const source = makeSource()
        const feed = yield* EventFeed.make(source.observe, { encode: (event) => event.id })
        expect((yield* feed.resume(undefined)).cursor).toBeUndefined()
        yield* source.publish(event("one"))
        yield* source.publish(event("two"))

        const fresh = yield* feed.resume(undefined)
        expect([fresh.resumed, fresh.cursor]).toEqual([undefined, "evt_two"])
        // Not resumable from this id and starting over: the cursor is where it starts.
        const lost = yield* feed.resume("evt_unknown")
        expect([lost.resumed, lost.cursor]).toEqual([false, "evt_two"])
        // Resuming: the client's own last id stays the anchor, so the replay it has yet to read is not skipped.
        const resumed = yield* feed.resume("evt_one")
        expect([resumed.resumed, resumed.cursor]).toEqual([true, undefined])
        // And an event after the cursor is delivered live, so the cursor never hides one.
        const received = yield* collect(fresh.stream, 1)
        yield* source.publish(event("three"))
        expect(yield* Fiber.join(received)).toEqual(["evt_three"])
      }),
    )

    it.effect("replays only what this subscriber may see, and only the requested types", () =>
      Effect.gen(function* () {
        const source = makeSource()
        const feed = yield* EventFeed.make(source.observe, { encode: (event) => event.id })
        yield* source.publish(event("anchor"))
        yield* source.publish(event("mine"))
        yield* source.publish(event("theirs"))
        yield* source.publish(internal("hidden"))

        const resumed = yield* feed.resume("evt_anchor", undefined, (candidate) => Effect.succeed(!candidate.id.startsWith("evt_theirs")))
        const received = yield* collect(resumed.stream, 2)
        yield* source.publish(event("theirs_live"))
        yield* source.publish(event("mine_live"))

        // Neither the replayed nor the live event of another organization reaches this subscriber.
        expect(yield* Fiber.join(received)).toEqual(["evt_mine", "evt_mine_live"])
      }),
    )

    it.live("a subscriber with no access gets nothing from the log", () =>
      Effect.gen(function* () {
        const source = makeSource()
        const feed = yield* EventFeed.make(source.observe, { encode: (event) => event.id })
        yield* source.publish(event("anchor"))
        yield* source.publish(event("secret"))
        const resumed = yield* feed.resume("evt_anchor", undefined, () => Effect.succeed(false))
        yield* source.publish(event("secret_live"))
        const received = yield* resumed.stream.pipe(Stream.take(1), Stream.runCollect, Effect.timeoutOption("100 millis"))
        expect([resumed.resumed, Option.isNone(received)]).toEqual([true, true])
      }),
    )
  })
})
