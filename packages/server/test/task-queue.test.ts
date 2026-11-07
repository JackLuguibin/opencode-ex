import fs from "node:fs/promises"
import path from "node:path"
import { expect } from "bun:test"
import { OpenCode } from "@opencode/client"
import { Effect } from "effect"
import { tmpdirScoped } from "../../core/test/fixture/tmpdir"
import { it } from "../../core/test/lib/effect"
import { ServerFetch } from "../src/fetch"

const client = (handler: (request: Request) => Promise<Response>) =>
  OpenCode.make({
    baseUrl: "http://opencode.local",
    fetch: Object.assign((input: string | URL | Request, init?: RequestInit) => handler(new Request(input, init)), {
      preconnect: fetch.preconnect,
    }),
  })

it.live("manages task queues through the experimental API", () =>
  Effect.gen(function* () {
    const dir = (yield* tmpdirScoped("opencode-queue-api-")).path
    const global = path.join(dir, "global")
    const project = path.join(dir, "project")
    yield* Effect.promise(() => Promise.all([global, project].map((item) => fs.mkdir(item, { recursive: true }))))
    const handler = yield* ServerFetch.make({
      app: { version: "test" },
      database: { path: path.join(dir, "opencode.db") },
      config: { directory: global, project: true, claude: false },
      models: { fetch: false },
      fs: { filewatcher: false },
    })
    const api = client(handler)

    yield* Effect.promise(async () => {
      const session = await api.session.create({ location: { directory: project } })
      const created = await api.experimental.taskQueue.create({
        name: "inbox",
        mode: "session",
        sessionID: session.id,
        capacity: 2,
      })
      expect(created).toMatchObject({
        name: "inbox",
        mode: "session",
        sessionID: session.id,
        capacity: 2,
        concurrency: 1,
        status: "active",
        counts: { pending: 0, running: 0, done: 0, failed: 0 },
      })

      // Pausing first keeps the background loop from picking the items up while the test reads them back.
      await api.experimental.taskQueue.pause({ queueID: created.id })
      const first = await api.experimental.taskQueue.enqueue({ queueID: created.id, prompt: "one" })
      await api.experimental.taskQueue.enqueue({ queueID: created.id, prompt: "two" })
      await expect(api.experimental.taskQueue.enqueue({ queueID: created.id, prompt: "three" })).rejects.toMatchObject({
        _tag: "ConflictError",
      })
      expect((await api.experimental.taskQueue.items({ queueID: created.id })).map((item) => item.prompt)).toEqual([
        "one",
        "two",
      ])
      expect(await api.experimental.taskQueue.list({ sessionID: session.id })).toMatchObject([
        { id: created.id, status: "paused", counts: { pending: 2 } },
      ])

      await api.experimental.taskQueue.cancel({ queueID: created.id, itemID: first.id })
      expect(
        await api.experimental.taskQueue.update({ queueID: created.id, name: "renamed", capacity: 5 }),
      ).toMatchObject({ name: "renamed", capacity: 5, counts: { pending: 1 } })
      await expect(
        api.experimental.taskQueue.update({ queueID: created.id, concurrency: 9 }),
      ).rejects.toMatchObject({ _tag: "InvalidRequestError" })

      const spawn = await api.experimental.taskQueue.create({
        name: "fanout",
        mode: "spawn",
        directory: project,
        capacity: 4,
        concurrency: 2,
      })
      expect(spawn).toMatchObject({ mode: "spawn", directory: project, concurrency: 2 })
      await expect(api.experimental.taskQueue.create({ name: "bad", mode: "spawn" })).rejects.toMatchObject({
        _tag: "InvalidRequestError",
      })

      await api.experimental.taskQueue.delete({ queueID: created.id })
      await api.experimental.taskQueue.delete({ queueID: spawn.id })
      await expect(api.experimental.taskQueue.get({ queueID: created.id })).rejects.toMatchObject({
        _tag: "TaskQueueNotFoundError",
      })
    })
  }),
)
