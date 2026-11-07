import { describe, expect } from "bun:test"
import { FileSystem } from "@opencode/core/filesystem"
import { Effect, Layer, LayerMap, Schema, Sink, Stream } from "effect"
import { ChildProcessSpawner } from "effect/process"
import { ExitCode, makeHandle, ProcessId } from "effect/process/ChildProcessSpawner"
import { Agent } from "@opencode/core/agent"
import { Database } from "@opencode/core/database/database"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { Environment } from "@opencode/core/environment/index"
import { FileAccess } from "@opencode/core/file-access"
import { Image } from "@opencode/core/image"
import { Instance } from "@opencode/core/instance/service"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { makeGlobalNode } from "@opencode/util/effect/app-node"
import { Bus } from "@opencode/core/bus"
import { Location } from "@opencode/core/location"
import { Permission } from "@opencode/core/permission"
import { PermissionSaved } from "@opencode/core/permission/saved"
import { Project } from "@opencode/core/project"
import { ProjectTable } from "@opencode/core/project/sql"
import { AbsolutePath } from "@opencode/core/schema"
import { Session } from "@opencode/core/session"
import { Identity } from "@opencode/core/identity"
import { TaskQueue } from "@opencode/core/task-queue"
import { SessionMessage } from "@opencode/core/session/message"
import { SessionProjector } from "@opencode/core/session/projector"
import { SessionExecution } from "@opencode/core/session/execution"
import { SessionInbox } from "@opencode/core/session/inbox"
import { SessionInboxTable, SessionTable } from "@opencode/core/session/sql"
import { SessionStore } from "@opencode/core/session/store"
import { ShellSelect } from "@opencode/core/shell/select"
import { Tool } from "@opencode/core/tool"
import { McpTool } from "@opencode/core/tool/mcp"
import { LocationServiceMap } from "@opencode/core/location-service-map"
import type { LocationServices } from "@opencode/core/location-services"
import { Plugin } from "@opencode/core/plugin"
import { PluginHooks } from "@opencode/core/plugin/hooks"
import { Snapshot } from "@opencode/core/snapshot"
import { Skill } from "@opencode/core/skill"
import { Config } from "@opencode/core/config"
import { Document, Info } from "@opencode/schema/config"
import { location } from "./fixture/location"
import { testEffect } from "./lib/effect"
import { imagePassthrough } from "./lib/image"

const enabledDirectory = "/enabled"
const toggleDirectory = "/toggle"
const missingDirectory = "/missing"

const wakes: Session.ID[] = []
/** Runs inside the next wake, which happens while a schedule is firing. */
let duringWake: Effect.Effect<void> = Effect.void
const execution = Layer.succeed(
  SessionExecution.Service,
  SessionExecution.Service.of({
    active: Effect.sync(() => new Set()),
    isActive: () => Effect.succeed(false),
    resume: () => Effect.void,
    interrupt: () => Effect.succeed(false),
    wake: (sessionID) =>
      Effect.suspend(() => {
        wakes.push(sessionID)
        const effect = duringWake
        duringWake = Effect.void
        return effect
      }),
    awaitIdle: () => Effect.void,
  }),
)
const enabledEntries = [
  new Document({
    type: "document",
    info: new Info({
      timezone: "America/New_York",
    }),
  }),
]
const disabledEntries = [
  new Document({
    type: "document",
    info: new Info({
    }),
  }),
]
const enabled = Config.testLayer(enabledEntries)
const disabled = Config.testLayer(disabledEntries)
/** A location whose flag the test turns on, counting every config read. */
const toggle = { on: false, reads: 0 }
const toggled = Layer.succeed(
  Config.Service,
  Config.Service.of({
    entries: () =>
      Effect.sync(() => {
        toggle.reads++
        return toggle.on ? enabledEntries : disabledEntries
      }),
    changes: () => Stream.empty,
  }),
)
/** Fake shell state and permission rules reset by `setup`. */
const shellState = {
  exitCode: 0,
  stdout: "",
  stderr: "",
  hangMs: 0,
  runs: [] as string[],
  missingNow: false,
}
const slack = { replies: 0, reads: 0, exports: 0, failing: false }
let agentRules: Permission.Ruleset = [{ action: "*", resource: "*", effect: "allow" }]
let activationGate: Effect.Effect<void> = Effect.void

const testEnvironment = Layer.effect(
  Environment.Service,
  Effect.gen(function* () {
    const memory = Environment.makeMemoryDriver()
    const files = Environment.makeFiles(memory)
    yield* files.mkdir(enabledDirectory).pipe(Effect.orDie)
    yield* files.mkdir(toggleDirectory).pipe(Effect.orDie)
    const spawner = ChildProcessSpawner.make((command) =>
      Effect.gen(function* () {
        const script = command._tag === "StandardCommand" ? (command.args.at(-1) ?? command.command) : "pipeline"
        shellState.runs.push(script)
        if (shellState.hangMs > 0) yield* Effect.sleep(shellState.hangMs)
        const outBytes = new TextEncoder().encode(shellState.stdout)
        const errBytes = new TextEncoder().encode(shellState.stderr)
        return makeHandle({
          pid: ProcessId(1),
          exitCode: Effect.succeed(ExitCode(shellState.exitCode)),
          isRunning: Effect.succeed(false),
          kill: () => Effect.void,
          stdin: Sink.drain,
          stdout: outBytes.byteLength > 0 ? Stream.make(outBytes) : Stream.empty,
          stderr: errBytes.byteLength > 0 ? Stream.make(errBytes) : Stream.empty,
          all: outBytes.byteLength > 0 ? Stream.make(outBytes) : Stream.empty,
          getInputFd: () => Sink.drain,
          getOutputFd: () => Stream.empty,
          unref: Effect.succeed(Effect.void),
        })
      }),
    )
    return Environment.Service.of({ files, spawner })
  }),
)

const configureAgent = Layer.effectDiscard(
  Effect.gen(function* () {
    const agents = yield* Agent.Service
    const tools = yield* Tool.Service
    const permission = yield* Permission.Service
    yield* agents.transform((editor) =>
      editor.update(Agent.defaultID, (agent) => {
        agent.permissions = [...agentRules]
      }),
    )
    yield* tools.transform((editor) => {
      editor.add({
        name: "read_thread",
        description: "Read the thread",
        input: Schema.Struct({}),
        output: Schema.Struct({ replies: Schema.Number }),
        options: { namespace: "slack" },
        execute: (_input, context) =>
          permission
            .assert({
              action: "slack_read_thread",
              resources: ["*"],
              sessionID: context.sessionID,
              agent: context.agent,
            })
            .pipe(
              Effect.orDie,
              Effect.flatMap(() => {
                if (slack.failing) return Effect.fail(new Tool.Error({ message: "Slack is down" }))
                slack.reads++
                return Effect.succeed({ output: { replies: slack.replies } })
              }),
            ),
      })
      editor.add({
        name: "export_thread",
        description: "Export the thread to a file",
        input: Schema.Struct({}),
        options: { namespace: "slack" },
        execute: (_input, context) =>
          permission
            .assert({ action: "file_write", resources: ["*"], sessionID: context.sessionID, agent: context.agent })
            .pipe(
              Effect.orDie,
              Effect.map(() => {
                slack.exports++
                return { content: "exported" }
              }),
            ),
      })
      editor.add({
        name: "dangerous_edit",
        description: "Mutates files",
        input: Schema.Struct({}),
        options: { namespace: "slack", permission: "edit" },
        execute: () => Effect.succeed({ content: "edited" }),
      })
    })
  }),
)

const locations = makeGlobalNode({
  service: LocationServiceMap.Service,
  layer: Layer.effect(
    LocationServiceMap.Service,
    Effect.gen(function* () {
      const bus = yield* Bus.Service
      const store = yield* SessionStore.Service
      const saved = yield* PermissionSaved.Service
      return yield* LayerMap.make(
        (ref: Location.Ref): Layer.Layer<LocationServices, FileSystem.DirectoryNotFoundError> => {
          if (ref.directory === missingDirectory && shellState.missingNow) {
            return Layer.effectDiscard(
              Effect.fail(
                new FileSystem.DirectoryNotFoundError({ directory: ref.directory, cause: new Error("missing") }),
              ),
            ) as unknown as Layer.Layer<LocationServices, FileSystem.DirectoryNotFoundError>
          }
          // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion
          return Layer.mergeAll(
            ref.directory === enabledDirectory || ref.directory === missingDirectory
              ? enabled
              : ref.directory === toggleDirectory
                ? toggled
                : disabled,
            configureAgent.pipe(
              Layer.provideMerge(
                LayerNode.compile(
                  LayerNode.group([
                    Location.node,
                    Environment.node,
                    PluginHooks.node,
                    Skill.node,
                    Tool.node,
                    Agent.node,
                    Permission.node,
                    FileAccess.node,
                  ]),
                  {
                    replacements: [
                      Bus.node.replace(Layer.succeed(Bus.Service, bus)),
                      SessionStore.node.replace(Layer.succeed(SessionStore.Service, store)),
                      PermissionSaved.node.replace(Layer.succeed(PermissionSaved.Service, saved)),
                      Location.node.replace(Layer.succeed(Location.Service, location(ref))),
                      Environment.node.replace(testEnvironment),
                      Image.node.replace(imagePassthrough),
                    ],
                  },
                ),
              ),
            ),
            Layer.mock(McpTool.Service, { flush: Effect.void }),
            Layer.succeed(
              ShellSelect.Service,
              ShellSelect.Service.of({
                transform: () => Effect.die("unused"),
                reload: () => Effect.void,
                resolve: () => Effect.succeed("/bin/bash"),
              }),
            ),
            Layer.mock(Snapshot.Service, { capture: () => Effect.undefined, restore: () => Effect.void }),
            Layer.succeed(Plugin.Service, {
              awaitActivation: Effect.suspend(() => activationGate),
            } as unknown as Plugin.Interface),
          ).pipe(Layer.fresh) as unknown as Layer.Layer<LocationServices, FileSystem.DirectoryNotFoundError>
        },
      )
    }),
  ),
  deps: [Bus.node, SessionStore.node, PermissionSaved.node],
})
const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([
      Database.node,
      Bus.node,
      SessionProjector.node,
      SessionStore.node,
      Session.node,
      Identity.node,
      TaskQueue.node,
      Instance.node,
      LocationServiceMap.node,
    ]),
    [
      Bus.node.replace(Bus.configured({ persist: true })),
      SessionExecution.node.replace(execution),
      LocationServiceMap.node.replace(locations),
    ],
  ),
)

const sessionID = Session.ID.make("ses_queue_test")

const setup = Effect.gen(function* () {
  const { db } = yield* Database.Service
  yield* db
    .insert(ProjectTable)
    .values({ id: Project.ID.global, worktree: AbsolutePath.make("/"), sandboxes: [] })
    .onConflictDoNothing()
    .run()
    .pipe(Effect.orDie)
  yield* db
    .insert(SessionTable)
    .values({
      id: sessionID,
      project_id: Project.ID.global,
      slug: "test",
      directory: enabledDirectory,
      title: "test",
      version: "test",
    })
    .onConflictDoNothing()
    .run()
    .pipe(Effect.orDie)
  wakes.length = 0
  duringWake = Effect.void
  return yield* TaskQueue.Service
})

const pending = Database.Service.use(({ db }) =>
  db
    .select({ id: SessionInboxTable.id })
    .from(SessionInboxTable)
    .all()
    .pipe(
      Effect.orDie,
      Effect.map((rows) => rows.map((row) => row.id)),
    ),
)

/** Moves pending prompts into the transcript, as a running Session would. */
const deliver = (target: Session.ID) =>
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    yield* SessionInbox.promote(db, yield* Bus.Service, target, "input")
  })

const states = (queues: TaskQueue.Interface, id: TaskQueue.ID) =>
  queues.items(id).pipe(Effect.map((items) => items.map((item) => item.status)))

describe("TaskQueue", () => {
  it.effect("refuses an item once the queue is full", () =>
    Effect.gen(function* () {
      const queues = yield* setup
      const queue = yield* queues.create({ name: "full", mode: "session", sessionID, capacity: 2, concurrency: 1 })
      yield* queues.enqueue(queue.id, { prompt: "one" })
      yield* queues.enqueue(queue.id, { prompt: "two" })
      expect(yield* Effect.flip(queues.enqueue(queue.id, { prompt: "three" }))).toMatchObject({
        _tag: "TaskQueue.FullError",
        capacity: 2,
      })
      expect((yield* queues.get(queue.id)).counts).toEqual({ pending: 2, running: 0, done: 0, failed: 0 })
      // A waiting item can be dropped, which frees its place.
      const [first] = yield* queues.items(queue.id)
      yield* queues.cancel(queue.id, first!.id)
      yield* queues.enqueue(queue.id, { prompt: "three" })
    }),
  )

  it.effect("rejects a concurrency above the capacity and a missing target", () =>
    Effect.gen(function* () {
      const queues = yield* setup
      expect(
        yield* Effect.flip(queues.create({ name: "x", mode: "session", sessionID, capacity: 2, concurrency: 3 })),
      ).toMatchObject({ _tag: "TaskQueue.InvalidError" })
      expect(yield* Effect.flip(queues.create({ name: "x", mode: "session" }))).toMatchObject({
        _tag: "TaskQueue.InvalidError",
      })
      expect(yield* Effect.flip(queues.create({ name: "x", mode: "spawn" }))).toMatchObject({
        _tag: "TaskQueue.InvalidError",
      })
    }),
  )

  it.effect("hands a session queue's items to its session one at a time", () =>
    Effect.gen(function* () {
      const queues = yield* setup
      const queue = yield* queues.create({ name: "serial", mode: "session", sessionID, concurrency: 5 })
      expect(queue.concurrency).toBe(1)
      const first = yield* queues.enqueue(queue.id, { prompt: "first" })
      const second = yield* queues.enqueue(queue.id, { prompt: "second" })

      yield* queues.tick
      expect(yield* states(queues, queue.id)).toEqual(["running", "pending"])
      expect(yield* pending).toEqual([SessionMessage.ID.make(`msg_${first.id}`)])

      // Still in the inbox: the session has not picked it up, so the next item keeps waiting.
      yield* queues.tick
      expect(yield* states(queues, queue.id)).toEqual(["running", "pending"])

      yield* deliver(sessionID)
      yield* queues.tick
      expect(yield* states(queues, queue.id)).toEqual(["done", "running"])
      expect(yield* pending).toEqual([SessionMessage.ID.make(`msg_${second.id}`)])

      yield* deliver(sessionID)
      yield* queues.tick
      expect((yield* queues.get(queue.id)).counts).toEqual({ pending: 0, running: 0, done: 2, failed: 0 })

      yield* queues.clear(queue.id)
      expect(yield* queues.items(queue.id)).toEqual([])
    }),
  )

  it.effect("starts a new session per item up to the concurrency", () =>
    Effect.gen(function* () {
      const queues = yield* setup
      const queue = yield* queues.create({
        name: "fanout",
        mode: "spawn",
        directory: AbsolutePath.make(enabledDirectory),
        concurrency: 2,
      })
      yield* Effect.forEach(["a", "b", "c"], (prompt) => queues.enqueue(queue.id, { prompt }))

      yield* queues.tick
      const started = yield* queues.items(queue.id)
      expect(started.map((item) => item.status)).toEqual(["running", "running", "pending"])
      const ids = started.flatMap((item) => (item.sessionID ? [item.sessionID] : []))
      expect(new Set(ids).size).toBe(2)
      expect(ids).not.toContain(sessionID)

      yield* Effect.forEach(ids, deliver)
      yield* queues.tick
      expect(yield* states(queues, queue.id)).toEqual(["done", "done", "running"])
    }),
  )

  it.effect("fails the items of a queue whose owner no longer exists", () =>
    Effect.gen(function* () {
      const queues = yield* setup
      const queue = yield* queues.create(
        { name: "orphan", mode: "spawn", directory: AbsolutePath.make(enabledDirectory) },
        { userID: "usr_gone" },
      )
      yield* queues.enqueue(queue.id, { prompt: "never" })
      yield* queues.tick
      expect(yield* queues.items(queue.id)).toMatchObject([
        { status: "failed", error: "The queue's owner no longer exists" },
      ])
    }),
  )

  describe("keeps a queue inside the organization it was made in", () => {
    // A real member of a fresh organization, so the checks that run before every start see an owner that exists.
    const member = (employeeID: string) =>
      Effect.gen(function* () {
        const identity = yield* Identity.Service
        const { token } = yield* identity.register({
          employeeID,
          password: "password-1",
          defaultOrganization: `Org ${employeeID}`,
        })
        const account = yield* identity.authenticate(token)
        if (!account?.organizationID) throw new Error("account has no organization")
        return { userID: account.userID, organizationID: account.organizationID, identity }
      })

    const refused = (queue: Pick<TaskQueue.Info, "id">, error: string) =>
      Effect.gen(function* () {
        const queues = yield* TaskQueue.Service
        yield* queues.enqueue(queue.id, { prompt: "p" })
        yield* queues.tick
        expect(yield* queues.items(queue.id)).toMatchObject([{ status: "failed", error }])
      })

    it.effect("fails items aimed at a directory outside the organization", () =>
      Effect.gen(function* () {
        const queues = yield* setup
        const owner = yield* member("9301")
        const queue = yield* queues.create(
          { name: "outside", mode: "spawn", directory: AbsolutePath.make(enabledDirectory) },
          owner,
        )
        yield* refused(queue, "The directory is outside the queue's organization")
      }),
    )

    it.effect("fails items aimed at the organization's shared space", () =>
      Effect.gen(function* () {
        const queues = yield* setup
        const owner = yield* member("9302")
        const shared = yield* owner.identity.organizationSharedDirectory(owner.organizationID)
        const queue = yield* queues.create({ name: "shared", mode: "spawn", directory: shared }, owner)
        yield* refused(queue, "The shared space cannot be a queue target")
      }),
    )

    it.effect("fails items of an owner who is no longer a member of the organization", () =>
      Effect.gen(function* () {
        const queues = yield* setup
        const owner = yield* member("9304")
        const other = yield* member("9305")
        // The owner's account still exists, but the organization is not one they belong to.
        const queue = yield* queues.create(
          { name: "left", mode: "spawn", directory: AbsolutePath.make(enabledDirectory) },
          { userID: owner.userID, organizationID: other.organizationID },
        )
        yield* refused(queue, "The queue's owner is no longer a member of its organization")
      }),
    )

    it.effect("fails items of a session that is no longer in the organization", () =>
      Effect.gen(function* () {
        const queues = yield* setup
        const owner = yield* member("9303")
        // The test session sits in the global project, which no organization holds.
        const queue = yield* queues.create({ name: "moved", mode: "session", sessionID }, owner)
        yield* refused(queue, "The session is no longer in the queue's organization")
      }),
    )
  })

  it.effect("starts nothing while paused and resumes where it stopped", () =>
    Effect.gen(function* () {
      const queues = yield* setup
      const queue = yield* queues.create({ name: "pausable", mode: "session", sessionID })
      yield* queues.enqueue(queue.id, { prompt: "later" })
      yield* queues.pause(queue.id)
      yield* queues.tick
      expect(yield* states(queues, queue.id)).toEqual(["pending"])
      expect((yield* queues.get(queue.id)).status).toBe("paused")
      yield* queues.resume(queue.id)
      yield* queues.tick
      expect(yield* states(queues, queue.id)).toEqual(["running"])
    }),
  )

  it.effect("reports a missing queue", () =>
    Effect.gen(function* () {
      const queues = yield* setup
      expect(yield* Effect.flip(queues.get(TaskQueue.ID.create()))).toMatchObject({ _tag: "TaskQueue.NotFoundError" })
    }),
  )
})
