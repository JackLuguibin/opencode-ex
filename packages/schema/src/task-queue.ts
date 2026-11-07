export * as TaskQueue from "./task-queue.js"

import { Schema } from "effect"
import { ephemeral, inventory } from "./event.js"
import { ascending } from "./identifier.js"
import { AbsolutePath, DateTimeUtcFromMillis, NonNegativeInt, PositiveInt, optional, statics } from "./schema.js"
import { SessionID } from "./session-id.js"

export const ID = Schema.String.check(Schema.isStartingWith("tqu_")).pipe(
  Schema.brand("TaskQueue.ID"),
  Schema.annotate({ identifier: "TaskQueue.ID" }),
  statics((schema) => ({
    create: () => schema.make("tqu_" + ascending()),
  })),
)
export type ID = typeof ID.Type

export const ItemID = Schema.String.check(Schema.isStartingWith("tqi_")).pipe(
  Schema.brand("TaskQueue.ItemID"),
  Schema.annotate({ identifier: "TaskQueue.ItemID" }),
  statics((schema) => ({
    create: () => schema.make("tqi_" + ascending()),
  })),
)
export type ItemID = typeof ItemID.Type

/**
 * `session` hands every item to one existing Session, one at a time. `spawn` starts a new Session in `directory`
 * for each item, up to `concurrency` at once.
 */
export const Mode = Schema.Literals(["session", "spawn"]).annotate({ identifier: "TaskQueue.Mode" })
export type Mode = typeof Mode.Type

export const Status = Schema.Literals(["active", "paused"]).annotate({ identifier: "TaskQueue.Status" })
export type Status = typeof Status.Type

export const ItemStatus = Schema.Literals(["pending", "running", "done", "failed"]).annotate({
  identifier: "TaskQueue.ItemStatus",
})
export type ItemStatus = typeof ItemStatus.Type

export const Counts = Schema.Struct({
  pending: NonNegativeInt,
  running: NonNegativeInt,
  done: NonNegativeInt,
  failed: NonNegativeInt,
}).annotate({ identifier: "TaskQueue.Counts" })
export type Counts = typeof Counts.Type

export const Info = Schema.Struct({
  id: ID,
  name: Schema.String,
  mode: Mode,
  sessionID: SessionID.pipe(optional),
  directory: Schema.String.pipe(optional),
  capacity: PositiveInt.annotate({ description: "Most items that may wait or run at once." }),
  concurrency: PositiveInt.annotate({ description: "Most items running at once. Always 1 for `session` queues." }),
  status: Status,
  /** The member who made the queue; sessions it starts run as them. */
  userID: Schema.String.pipe(optional),
  /** The organization the queue was made in; members of other organizations never see it. */
  organizationID: Schema.String.pipe(optional),
  counts: Counts,
  time: Schema.Struct({ created: DateTimeUtcFromMillis, updated: DateTimeUtcFromMillis }),
}).annotate({ identifier: "TaskQueue.Info" })
export type Info = typeof Info.Type

export const Item = Schema.Struct({
  id: ItemID,
  queueID: ID,
  prompt: Schema.String,
  status: ItemStatus,
  sessionID: SessionID.pipe(optional),
  error: Schema.String.pipe(optional),
  time: Schema.Struct({
    created: DateTimeUtcFromMillis,
    started: DateTimeUtcFromMillis.pipe(optional),
    finished: DateTimeUtcFromMillis.pipe(optional),
  }),
}).annotate({ identifier: "TaskQueue.Item" })
export type Item = typeof Item.Type

const limits = {
  capacity: PositiveInt.pipe(optional),
  concurrency: PositiveInt.pipe(optional),
}

/** `sessionID` is required for `session` queues, `directory` for `spawn` queues. */
export const CreateInput = Schema.Struct({
  name: Schema.String.check(Schema.isMinLength(1)),
  mode: Mode,
  sessionID: SessionID.pipe(optional),
  directory: AbsolutePath.pipe(optional),
  ...limits,
}).annotate({ identifier: "TaskQueue.CreateInput" })
export type CreateInput = typeof CreateInput.Type

export const UpdateInput = Schema.Struct({
  name: Schema.String.check(Schema.isMinLength(1)).pipe(optional),
  sessionID: SessionID.pipe(optional),
  directory: AbsolutePath.pipe(optional),
  ...limits,
}).annotate({ identifier: "TaskQueue.UpdateInput" })
export type UpdateInput = typeof UpdateInput.Type

export const EnqueueInput = Schema.Struct({
  prompt: Schema.String.check(Schema.isMinLength(1)),
}).annotate({ identifier: "TaskQueue.EnqueueInput" })
export type EnqueueInput = typeof EnqueueInput.Type

export const DEFAULT_CAPACITY = 50
export const DEFAULT_CONCURRENCY = 2

/** A queue, or one of its items, changed; clients refetch that queue instead of polling. */
const Changed = ephemeral({ type: "taskqueue.changed", schema: { queueID: ID } })
export const Event = { Changed, Definitions: inventory(Changed) }
