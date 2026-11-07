export * as TaskQueueTool from "./task-queue.js"

import { ToolFailure } from "@opencode/ai/effect"
import type { Context } from "@opencode/plugin/effect/plugin"
import { PositiveInt } from "@opencode/schema/schema"
import { Effect, Schema } from "effect"
import { TaskQueue } from "../../task-queue.js"

export const name = "task_dispatch"

export const Input = Schema.Struct({
  tasks: Schema.Array(
    Schema.Struct({
      prompt: Schema.String.check(Schema.isMinLength(1)).annotate({
        description:
          "A self-contained prompt for one subtask. Start with a one-line title; it names the subtask's session in the sidebar.",
      }),
    }),
  )
    .check(Schema.isMinLength(1))
    .annotate({ description: "The subtasks to queue, in the order they should start." }),
  concurrency: PositiveInt.pipe(Schema.optional).annotate({
    description: "How many subtasks may run at once. Defaults to 2.",
  }),
})

export const Output = Schema.Struct({
  queueID: TaskQueue.ID,
  queued: Schema.Number,
})

export const Plugin = {
  id: "opencode.tool.task-queue",
  effect: Effect.fn("TaskQueueTool.Plugin")(function* (ctx: Context) {
    const queues = yield* TaskQueue.Service
    const failure = (error: { readonly message: string }) => new ToolFailure({ message: error.message, error })

    yield* ctx.tool.transform((editor) => {
      editor.add({
        name,
        description:
          "Push subtasks onto a task queue. Each one starts its own session as a child of this session, shown under it in the sidebar, and runs a few at a time. Call it once with every subtask; it returns as soon as they are queued, without waiting for them to finish.",
        input: Input,
        output: Output,
        options: { codemode: false },
        execute: (input, context) =>
          Effect.gen(function* () {
            // Later calls from the same session add to its queue instead of starting a second one.
            const existing = (yield* queues.list({ sessionID: context.sessionID })).find(
              (queue) => queue.mode === "spawn" && queue.directory === undefined,
            )
            const queue =
              existing ??
              (yield* queues.create({
                name: "Subtasks",
                mode: "spawn",
                sessionID: context.sessionID,
                ...(input.concurrency === undefined ? {} : { concurrency: input.concurrency }),
              }))
            // Checked up front so a full queue never takes half the subtasks and then fails, which a retry would duplicate.
            const used = queue.counts.pending + queue.counts.running
            if (used + input.tasks.length > queue.capacity)
              return yield* new ToolFailure({
                message: `The queue has room for ${Math.max(queue.capacity - used, 0)} more subtasks, but ${input.tasks.length} were given.`,
              })
            if (queue.status === "paused") yield* queues.resume(queue.id)
            yield* Effect.forEach(input.tasks, (task) => queues.enqueue(queue.id, { prompt: task.prompt }), {
              discard: true,
            })
            return {
              output: { queueID: queue.id, queued: input.tasks.length },
              content: `Queued ${input.tasks.length} subtask(s) as child sessions of this session.`,
            }
          }).pipe(Effect.mapError(failure)),
      })
    })
  }),
}
