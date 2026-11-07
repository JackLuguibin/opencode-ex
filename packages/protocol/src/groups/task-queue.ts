import { Session } from "@opencode/schema/session"
import { TaskQueue } from "@opencode/schema/task-queue"
import { Schema } from "effect"
import { HttpApiEndpoint, HttpApiSchema, OpenApi } from "effect/http-api"
import {
  ConflictError,
  ForbiddenError,
  InvalidRequestError,
  LocationNotFoundError,
  SessionNotFoundError,
  TaskQueueNotFoundError,
} from "../errors.js"

const EXPERIMENTAL = "Experimental: internal OpenCode task queue API; wire shape may change without notice."
const errors = [TaskQueueNotFoundError, ForbiddenError] as const
const params = { queueID: TaskQueue.ID }
const annotations = (identifier: string, summary: string, description: string) =>
  OpenApi.annotations({
    identifier: `experimental.taskQueue.${identifier}`,
    summary,
    description: `${description} ${EXPERIMENTAL}`,
    transform: (operation) => ({ ...operation, tags: ["experimental"] }),
  })

/** Lives in the `server.experimental` group (see `groups/experimental.ts`). */
export const TaskQueueEndpoints = [
  HttpApiEndpoint.post("taskQueue.create", "/api/experimental/queue", {
    payload: TaskQueue.CreateInput,
    success: Schema.Struct({ data: TaskQueue.Info }),
    error: [InvalidRequestError, SessionNotFoundError, LocationNotFoundError, ForbiddenError],
  }).annotateMerge(
    annotations(
      "create",
      "Create queue",
      "Create a queue whose items one Session works through in turn, or that starts a new Session per item.",
    ),
  ),
  HttpApiEndpoint.get("taskQueue.list", "/api/experimental/queue", {
    query: { sessionID: Schema.optional(Session.ID) },
    success: Schema.Struct({ data: Schema.Array(TaskQueue.Info) }),
    error: [SessionNotFoundError, ForbiddenError],
  }).annotateMerge(annotations("list", "List queues", "List the queues the caller can see, oldest first.")),
  HttpApiEndpoint.get("taskQueue.get", "/api/experimental/queue/:queueID", {
    params,
    success: Schema.Struct({ data: TaskQueue.Info }),
    error: errors,
  }).annotateMerge(annotations("get", "Get queue", "Read one queue with its item counts.")),
  HttpApiEndpoint.patch("taskQueue.update", "/api/experimental/queue/:queueID", {
    params,
    payload: TaskQueue.UpdateInput,
    success: Schema.Struct({ data: TaskQueue.Info }),
    error: [...errors, InvalidRequestError, SessionNotFoundError, LocationNotFoundError],
  }).annotateMerge(annotations("update", "Update queue", "Rename a queue, change its size or concurrency, or retarget it.")),
  HttpApiEndpoint.delete("taskQueue.delete", "/api/experimental/queue/:queueID", {
    params,
    success: HttpApiSchema.NoContent,
    error: errors,
  }).annotateMerge(annotations("delete", "Delete queue", "Delete a queue and its items. Sessions it started are kept.")),
  HttpApiEndpoint.post("taskQueue.pause", "/api/experimental/queue/:queueID/pause", {
    params,
    success: Schema.Struct({ data: TaskQueue.Info }),
    error: errors,
  }).annotateMerge(annotations("pause", "Pause queue", "Stop starting items. Running items finish.")),
  HttpApiEndpoint.post("taskQueue.resume", "/api/experimental/queue/:queueID/resume", {
    params,
    success: Schema.Struct({ data: TaskQueue.Info }),
    error: errors,
  }).annotateMerge(annotations("resume", "Resume queue", "Start taking items again.")),
  HttpApiEndpoint.get("taskQueue.items", "/api/experimental/queue/:queueID/item", {
    params,
    success: Schema.Struct({ data: Schema.Array(TaskQueue.Item) }),
    error: errors,
  }).annotateMerge(annotations("items", "List queue items", "List a queue's items, oldest first.")),
  HttpApiEndpoint.post("taskQueue.enqueue", "/api/experimental/queue/:queueID/item", {
    params,
    payload: TaskQueue.EnqueueInput,
    success: Schema.Struct({ data: TaskQueue.Item }),
    error: [...errors, ConflictError],
  }).annotateMerge(annotations("enqueue", "Add queue item", "Add a prompt to the end of the queue. Fails with 409 when the queue is full.")),
  HttpApiEndpoint.delete("taskQueue.cancel", "/api/experimental/queue/:queueID/item/:itemID", {
    params: { ...params, itemID: TaskQueue.ItemID },
    success: HttpApiSchema.NoContent,
    error: [...errors, InvalidRequestError],
  }).annotateMerge(annotations("cancel", "Cancel queue item", "Remove an item that is still waiting.")),
  HttpApiEndpoint.delete("taskQueue.clear", "/api/experimental/queue/:queueID/item", {
    params,
    success: HttpApiSchema.NoContent,
    error: errors,
  }).annotateMerge(annotations("clear", "Clear finished items", "Forget the queue's done and failed items.")),
] as const
