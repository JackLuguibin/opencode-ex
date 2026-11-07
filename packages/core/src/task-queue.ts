export * as TaskQueue from "./task-queue.js"

import path from "node:path"
import { and, asc, count, eq, inArray } from "drizzle-orm"
import { Cause, Clock, Context, DateTime, Effect, Latch, Layer, Schema } from "effect"
import { Node, makeGlobalNode } from "@opencode/util/effect/app-node"
import { LayerNode } from "@opencode/util/effect/layer-node"
import {
  CreateInput,
  DEFAULT_CAPACITY,
  DEFAULT_CONCURRENCY,
  EnqueueInput,
  ID,
  Info,
  Item,
  ItemID,
  ItemStatus,
  Mode,
  Status,
  UpdateInput,
} from "@opencode/schema/task-queue"
import { AbsolutePath } from "@opencode/schema/schema"
import { Database } from "./database/database.js"
import { Identity } from "./identity.js"
import { Session } from "./session.js"
import { SessionExecution } from "./session/execution.js"
import { SessionMessage } from "./session/message.js"
import { SessionSchema } from "./session/schema.js"
import { SessionInboxTable } from "./session/sql.js"
import { TaskQueueItemTable, TaskQueueTable } from "./task-queue/sql.js"

export { ID, ItemID, Info, Item, CreateInput, UpdateInput, EnqueueInput, Mode, Status, ItemStatus }

export class NotFoundError extends Schema.TaggedError<NotFoundError>()("TaskQueue.NotFoundError", {
  queueID: ID,
}) {
  override get message() {
    return `Queue not found: ${this.queueID}`
  }
}

export class ItemNotFoundError extends Schema.TaggedError<ItemNotFoundError>()("TaskQueue.ItemNotFoundError", {
  itemID: ItemID,
}) {
  override get message() {
    return `Queue item not found: ${this.itemID}`
  }
}

export class InvalidError extends Schema.TaggedError<InvalidError>()("TaskQueue.InvalidError", {
  reason: Schema.String,
}) {
  override get message() {
    return this.reason
  }
}

export class FullError extends Schema.TaggedError<FullError>()("TaskQueue.FullError", {
  queueID: ID,
  capacity: Schema.Number,
}) {
  override get message() {
    return `Queue is full (${this.capacity} items)`
  }
}

export interface Interface {
  readonly create: (input: CreateInput, owner?: { readonly userID: string; readonly organizationID?: string }) => Effect.Effect<Info, InvalidError | Session.NotFoundError>
  readonly list: (input?: { readonly sessionID?: SessionSchema.ID }) => Effect.Effect<Info[]>
  readonly get: (id: ID) => Effect.Effect<Info, NotFoundError>
  readonly update: (id: ID, input: UpdateInput) => Effect.Effect<Info, NotFoundError | InvalidError | Session.NotFoundError>
  readonly pause: (id: ID) => Effect.Effect<Info, NotFoundError>
  readonly resume: (id: ID) => Effect.Effect<Info, NotFoundError>
  readonly remove: (id: ID) => Effect.Effect<void, NotFoundError>
  readonly items: (id: ID) => Effect.Effect<Item[], NotFoundError>
  readonly enqueue: (id: ID, input: EnqueueInput) => Effect.Effect<Item, NotFoundError | FullError>
  /** Drops a waiting item. A running item is left to finish. */
  readonly cancel: (id: ID, itemID: ItemID) => Effect.Effect<void, NotFoundError | ItemNotFoundError | InvalidError>
  /** Forgets the finished and failed items, keeping what waits or runs. */
  readonly clear: (id: ID) => Effect.Effect<void, NotFoundError>
  /** Finishes the items whose Session went idle and starts as many waiting ones as the queue's limits allow. */
  readonly tick: Effect.Effect<void>
  /** Runs `tick` until interrupted, at least every few seconds and whenever a queue changes. */
  readonly run: Effect.Effect<never>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/TaskQueue") {}

type QueueRow = typeof TaskQueueTable.$inferSelect
type ItemRow = typeof TaskQueueItemTable.$inferSelect

/** The loop re-reads the tables at least this often; sessions finishing is not announced to it. */
const POLL = 3_000
const OPEN: ItemStatus[] = ["pending", "running"]

const time = (value: number) => DateTime.makeUnsafe(value)
const optionalTime = (value: number | null) => (value === null ? undefined : time(value))

const toItem = (row: ItemRow): Item => ({
  id: row.id,
  queueID: row.queue_id,
  prompt: row.prompt,
  status: row.status,
  sessionID: row.session_id ?? undefined,
  error: row.error ?? undefined,
  time: { created: time(row.time_created), started: optionalTime(row.time_started), finished: optionalTime(row.time_finished) },
})

/** The message an item admits to its Session; derived from the item so a retry after a crash reconciles with it. */
const messageID = (id: ItemID) => SessionMessage.ID.make(`msg_${id}`)

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const database = yield* Database.Service
    const db = database.db
    const sessions = yield* Session.Service
    const execution = yield* SessionExecution.Service
    const identity = yield* Identity.Service
    const doorbell = yield* Latch.make()

    const find = (id: ID) =>
      db
        .select()
        .from(TaskQueueTable)
        .where(eq(TaskQueueTable.id, id))
        .get()
        .pipe(
          Effect.orDie,
          Effect.flatMap((row) => (row ? Effect.succeed(row) : Effect.fail(new NotFoundError({ queueID: id })))),
        )

    const countsFor = (id: ID) =>
      db
        .select({ status: TaskQueueItemTable.status, total: count() })
        .from(TaskQueueItemTable)
        .where(eq(TaskQueueItemTable.queue_id, id))
        .groupBy(TaskQueueItemTable.status)
        .all()
        .pipe(
          Effect.orDie,
          Effect.map((rows) => {
            const total = (status: ItemStatus) => rows.find((row) => row.status === status)?.total ?? 0
            return { pending: total("pending"), running: total("running"), done: total("done"), failed: total("failed") }
          }),
        )

    const toInfo = (row: QueueRow) =>
      countsFor(row.id).pipe(
        Effect.map(
          (counts): Info => ({
            id: row.id,
            name: row.name,
            mode: row.mode,
            sessionID: row.session_id ?? undefined,
            directory: row.directory ?? undefined,
            capacity: row.capacity,
            concurrency: row.mode === "session" ? 1 : row.concurrency,
            status: row.status,
            userID: row.user_id ?? undefined,
            organizationID: row.organization_id ?? undefined,
            counts,
            time: { created: time(row.time_created), updated: time(row.time_updated) },
          }),
        ),
      )

    const touch = (id: ID, values: Partial<QueueRow>) =>
      Clock.currentTimeMillis.pipe(
        Effect.flatMap((now) =>
          db
            .update(TaskQueueTable)
            .set({ ...values, time_updated: now })
            .where(eq(TaskQueueTable.id, id))
            .run(),
        ),
        Effect.orDie,
      )

    const settle = (item: ItemRow, values: Partial<ItemRow>) =>
      Clock.currentTimeMillis.pipe(
        Effect.flatMap((now) =>
          db
            .update(TaskQueueItemTable)
            .set({ ...values, time_finished: now, time_updated: now })
            .where(and(eq(TaskQueueItemTable.id, item.id), eq(TaskQueueItemTable.status, "running")))
            .run(),
        ),
        Effect.orDie,
      )

    const admitted = (item: ItemRow) =>
      db
        .select({ id: SessionInboxTable.id })
        .from(SessionInboxTable)
        .where(eq(SessionInboxTable.id, messageID(item.id)))
        .get()
        .pipe(
          Effect.orDie,
          Effect.map((row) => row !== undefined),
        )

    // A running item is finished once its prompt left the inbox and its Session stopped working.
    const finish = Effect.fnUntraced(function* (item: ItemRow) {
      if (item.session_id === null) return yield* settle(item, { status: "failed", error: "Session was not recorded" })
      const exists = yield* sessions.get(item.session_id).pipe(
        Effect.as(true),
        Effect.catchTag("Session.NotFoundError", () => Effect.succeed(false)),
      )
      if (!exists) return yield* settle(item, { status: "failed", error: "Session was deleted" })
      if (yield* admitted(item)) return
      if (yield* execution.isActive(item.session_id)) return
      yield* settle(item, { status: "done" })
    })

    // The queue was authorized when it was made, but it keeps running as its creator for as long as it lives. Before
    // every start, check that the creator still exists and the target is still inside the organization it was made in.
    const refusal = Effect.fnUntraced(function* (queue: QueueRow) {
      if (queue.user_id === null) return undefined
      if (!(yield* identity.employeeIDs([queue.user_id])).has(queue.user_id)) return "The queue's owner no longer exists"
      if (queue.organization_id === null) return undefined
      if (queue.mode === "session") {
        if (queue.session_id === null) return undefined
        const session = yield* sessions.get(queue.session_id).pipe(Effect.catchTag("Session.NotFoundError", () => Effect.succeed(undefined)))
        if (!session) return undefined
        return (yield* identity.projectAccess(session.projectID))?.organizationID === queue.organization_id
          ? undefined
          : "The session is no longer in the queue's organization"
      }
      if (queue.directory === null) return undefined
      const target = path.resolve(queue.directory)
      const inside = path.relative(yield* identity.organizationRoot(queue.organization_id), target)
      if (inside === "" || inside.startsWith("..") || path.isAbsolute(inside)) return "The directory is outside the queue's organization"
      const shared = path.relative(yield* identity.organizationSharedDirectory(queue.organization_id), target)
      return shared === "" || !(shared.startsWith("..") || path.isAbsolute(shared)) ? "The shared space cannot be a queue target" : undefined
    })

    // Starts an item the caller already claimed (pending -> running), failing it if its Session cannot take the prompt.
    const start = Effect.fnUntraced(function* (queue: QueueRow, item: ItemRow) {
      const refused = yield* refusal(queue)
      if (refused !== undefined) return yield* settle(item, { status: "failed", error: refused })
      const target =
        queue.mode === "session"
          ? queue.session_id
          : queue.directory === null
            ? null
            : yield* sessions
                .create({ location: { directory: AbsolutePath.make(queue.directory) }, title: item.prompt.slice(0, 80) })
                .pipe(
                  Effect.tap((created) =>
                    queue.user_id === null ? Effect.void : identity.touchSessionUser(created.id, queue.user_id),
                  ),
                  Effect.map((created) => created.id),
                )
      if (target === null) return yield* settle(item, { status: "failed", error: "Queue has no target" })
      yield* db
        .update(TaskQueueItemTable)
        .set({ session_id: target })
        .where(eq(TaskQueueItemTable.id, item.id))
        .run()
        .pipe(Effect.orDie)
      yield* sessions.prompt({ sessionID: target, id: messageID(item.id), text: item.prompt, delivery: "queue" })
    })

    const fill = Effect.fnUntraced(function* (queue: QueueRow) {
      const limit = queue.mode === "session" ? 1 : queue.concurrency
      const running = yield* db
        .select({ total: count() })
        .from(TaskQueueItemTable)
        .where(and(eq(TaskQueueItemTable.queue_id, queue.id), eq(TaskQueueItemTable.status, "running")))
        .get()
        .pipe(Effect.orDie)
      const slots = limit - (running?.total ?? 0)
      if (slots <= 0) return
      const waiting = yield* db
        .select()
        .from(TaskQueueItemTable)
        .where(and(eq(TaskQueueItemTable.queue_id, queue.id), eq(TaskQueueItemTable.status, "pending")))
        .orderBy(asc(TaskQueueItemTable.time_created), asc(TaskQueueItemTable.id))
        .limit(slots)
        .all()
        .pipe(Effect.orDie)
      yield* Effect.forEach(
        waiting,
        (item) =>
          Effect.gen(function* () {
            const now = yield* Clock.currentTimeMillis
            // Claiming is a conditional update, so two processes sharing the database never start the same item.
            const claimed = yield* db
              .update(TaskQueueItemTable)
              .set({ status: "running", time_started: now, time_updated: now })
              .where(and(eq(TaskQueueItemTable.id, item.id), eq(TaskQueueItemTable.status, "pending")))
              .returning()
              .get()
              .pipe(Effect.orDie)
            if (!claimed) return
            yield* start(queue, claimed).pipe(
              Effect.catchCause((cause) =>
                settle(claimed, { status: "failed", error: String(Cause.squash(cause)) }),
              ),
            )
          }),
        { discard: true },
      )
    })

    const tick = Effect.gen(function* () {
      const queues = yield* db.select().from(TaskQueueTable).all().pipe(Effect.orDie)
      yield* Effect.forEach(
        queues,
        (queue) =>
          Effect.gen(function* () {
            const running = yield* db
              .select()
              .from(TaskQueueItemTable)
              .where(and(eq(TaskQueueItemTable.queue_id, queue.id), eq(TaskQueueItemTable.status, "running")))
              .all()
              .pipe(Effect.orDie)
            yield* Effect.forEach(running, finish, { discard: true })
            if (queue.status === "active") yield* fill(queue)
          }).pipe(Effect.catchCause((cause) => Effect.logError("task queue tick failed", { queue: queue.id, cause }))),
        { discard: true },
      )
    })

    const run = Effect.forever(
      doorbell.close.pipe(
        Effect.andThen(tick),
        Effect.andThen(doorbell.await.pipe(Effect.timeoutOption(POLL))),
      ),
    )

    // Every limit is checked here so the loop never has to cope with a zero or oversized value.
    const limits = (input: { capacity?: number; concurrency?: number }, current?: QueueRow) => {
      const capacity = input.capacity ?? current?.capacity ?? DEFAULT_CAPACITY
      const concurrency = input.concurrency ?? current?.concurrency ?? DEFAULT_CONCURRENCY
      if (concurrency > capacity)
        return Effect.fail(new InvalidError({ reason: "concurrency cannot be larger than capacity" }))
      return Effect.succeed({ capacity, concurrency })
    }

    return Service.of({
      create: Effect.fn("TaskQueue.create")(function* (input, owner) {
        if (input.mode === "session" && input.sessionID === undefined)
          return yield* new InvalidError({ reason: "A session queue needs a sessionID" })
        if (input.mode === "spawn" && input.directory === undefined)
          return yield* new InvalidError({ reason: "A spawn queue needs a directory" })
        if (input.sessionID !== undefined) yield* sessions.get(input.sessionID)
        const size = yield* limits(input)
        const now = yield* Clock.currentTimeMillis
        const row = yield* db
          .insert(TaskQueueTable)
          .values({
            id: ID.create(),
            name: input.name,
            mode: input.mode,
            session_id: input.mode === "session" ? (input.sessionID ?? null) : null,
            directory: input.mode === "spawn" ? (input.directory ?? null) : null,
            ...size,
            user_id: owner?.userID ?? null,
            organization_id: owner?.organizationID ?? null,
            time_created: now,
            time_updated: now,
          })
          .returning()
          .get()
          .pipe(Effect.orDie)
        return yield* toInfo(row)
      }),
      list: Effect.fn("TaskQueue.list")(function* (input) {
        const rows = yield* db
          .select()
          .from(TaskQueueTable)
          .where(input?.sessionID === undefined ? undefined : eq(TaskQueueTable.session_id, input.sessionID))
          .orderBy(asc(TaskQueueTable.time_created), asc(TaskQueueTable.id))
          .all()
          .pipe(Effect.orDie)
        return yield* Effect.forEach(rows, toInfo)
      }),
      get: Effect.fn("TaskQueue.get")(function* (id) {
        return yield* toInfo(yield* find(id))
      }),
      update: Effect.fn("TaskQueue.update")(function* (id, input) {
        const row = yield* find(id)
        const size = yield* limits(input, row)
        if (input.sessionID !== undefined) yield* sessions.get(input.sessionID)
        yield* touch(id, {
          ...size,
          ...(input.name === undefined ? {} : { name: input.name }),
          ...(input.sessionID !== undefined && row.mode === "session" ? { session_id: input.sessionID } : {}),
          ...(input.directory !== undefined && row.mode === "spawn" ? { directory: input.directory } : {}),
        })
        yield* doorbell.open
        return yield* toInfo(yield* find(id))
      }),
      pause: Effect.fn("TaskQueue.pause")(function* (id) {
        yield* find(id)
        yield* touch(id, { status: "paused" })
        return yield* toInfo(yield* find(id))
      }),
      resume: Effect.fn("TaskQueue.resume")(function* (id) {
        yield* find(id)
        yield* touch(id, { status: "active" })
        yield* doorbell.open
        return yield* toInfo(yield* find(id))
      }),
      remove: Effect.fn("TaskQueue.remove")(function* (id) {
        yield* find(id)
        yield* db.delete(TaskQueueTable).where(eq(TaskQueueTable.id, id)).run().pipe(Effect.orDie)
      }),
      items: Effect.fn("TaskQueue.items")(function* (id) {
        yield* find(id)
        const rows = yield* db
          .select()
          .from(TaskQueueItemTable)
          .where(eq(TaskQueueItemTable.queue_id, id))
          .orderBy(asc(TaskQueueItemTable.time_created), asc(TaskQueueItemTable.id))
          .all()
          .pipe(Effect.orDie)
        return rows.map(toItem)
      }),
      enqueue: Effect.fn("TaskQueue.enqueue")(function* (id, input) {
        const queue = yield* find(id)
        const open = yield* db
          .select({ total: count() })
          .from(TaskQueueItemTable)
          .where(and(eq(TaskQueueItemTable.queue_id, id), inArray(TaskQueueItemTable.status, OPEN)))
          .get()
          .pipe(Effect.orDie)
        if ((open?.total ?? 0) >= queue.capacity) return yield* new FullError({ queueID: id, capacity: queue.capacity })
        const now = yield* Clock.currentTimeMillis
        const row = yield* db
          .insert(TaskQueueItemTable)
          .values({ id: ItemID.create(), queue_id: id, prompt: input.prompt, time_created: now, time_updated: now })
          .returning()
          .get()
          .pipe(Effect.orDie)
        yield* doorbell.open
        return toItem(row)
      }),
      cancel: Effect.fn("TaskQueue.cancel")(function* (id, itemID) {
        yield* find(id)
        const row = yield* db
          .select()
          .from(TaskQueueItemTable)
          .where(and(eq(TaskQueueItemTable.id, itemID), eq(TaskQueueItemTable.queue_id, id)))
          .get()
          .pipe(Effect.orDie)
        if (!row) return yield* new ItemNotFoundError({ itemID })
        if (row.status !== "pending") return yield* new InvalidError({ reason: "Only a waiting item can be cancelled" })
        yield* db
          .delete(TaskQueueItemTable)
          .where(and(eq(TaskQueueItemTable.id, itemID), eq(TaskQueueItemTable.status, "pending")))
          .run()
          .pipe(Effect.orDie)
      }),
      clear: Effect.fn("TaskQueue.clear")(function* (id) {
        yield* find(id)
        yield* db
          .delete(TaskQueueItemTable)
          .where(and(eq(TaskQueueItemTable.queue_id, id), inArray(TaskQueueItemTable.status, ["done", "failed"])))
          .run()
          .pipe(Effect.orDie)
      }),
      tick,
      run,
    })
  }),
)

export const node: LayerNode.Provider<Service, never, typeof Node.tags.values.global> = makeGlobalNode({
  service: Service,
  layer,
  deps: [Database.node, Session.node, SessionExecution.node, Identity.node],
})
