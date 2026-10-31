export * as ServerProcess from "./process"

import { NodeHttpServer } from "@effect/platform-node"
import { Bus } from "@opencode/core/bus"
import { SessionExecution } from "@opencode/core/session/execution"
import { SessionRestart } from "@opencode/core/session/execution/restart"
import { InstallationEvent } from "@opencode/schema/installation-event"
import { hasPtyConnectTicketURL } from "@opencode/protocol/groups/pty"
import { hasPersistentPtyConnectTicketURL } from "@opencode/protocol/groups/persistent-pty"
import { hasMcpClientTicketURL } from "@opencode/protocol/groups/mcp"
import { isPairingConnectURL } from "@opencode/protocol/groups/server"
import { GlobalSync } from "@opencode/core/global-sync"
import { Global } from "@opencode/util/global"
import { RuntimeRegistry } from "@opencode/util/runtime-registry"
import { Cause, Context, Duration, Effect, Exit, Latch, Layer, Option, Ref, Schedule, Scope } from "effect"
import { HttpMiddleware, HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http"
import { NetAddress } from "effect/net"
import { RedisClient } from "bun"
import { createServer } from "node:http"
import { ServerAuth } from "./auth"
import { isAllowedCorsOrigin } from "./cors"
import {
  AUTH_GUEST_CONFIG_PATH,
  AUTH_GUEST_PATH,
  AUTH_LOGIN_PATH,
  AUTH_REGISTER_PATH,
  AUTH_UAC_CONFIG_PATH,
  AUTH_UAC_PATH,
} from "@opencode/protocol/groups/auth"
import { authorizedRequest, unauthorizedResponse } from "./middleware/authorization"
import { withoutParentSpan } from "./request-tracing"
import { createRoutes } from "./routes"
import { PackageSync } from "./package-sync"
import * as Presence from "./presence"
import { ReplayGuard } from "./replay-guard"
import { ServerInfo } from "./server-info"
import { Status } from "./service-status"
import type { ServerOptions } from "./options"

export interface Lifecycle<E = never, R = never> {
  readonly onListen: (
    address: NetAddress.SocketAddress,
    shutdown: Effect.Effect<void>,
  ) => Effect.Effect<Effect.Effect<void>, E, R>
}

type App = Effect.Effect<
  HttpServerResponse.HttpServerResponse,
  unknown,
  HttpServerRequest.HttpServerRequest | Scope.Scope
>

export type Transform = (app: App) => App

const errorResponseLogger = HttpMiddleware.make((app) =>
  HttpMiddleware.logger(
    Effect.tap(app, (response) =>
      response.status < 400 ? HttpMiddleware.withLoggerDisabled(Effect.void) : Effect.void,
    ),
  ),
)

export const start = Effect.fn("ServerProcess.start")(function* <E, R>(
  options: ServerOptions,
  lifecycle?: Lifecycle<E, R>,
  transform?: Transform,
  remoteURLs?: () => ReadonlyArray<string>,
) {
  const password = options.password
  if (!password) return yield* Effect.fail(new Error("Missing server password"))
  const hostname = options.hostname ?? "127.0.0.1"
  const port = Option.fromNullishOr(options.port)
  const shutdown = yield* Latch.make()
  const status = yield* Status.make()
  const bound = yield* listen({ hostname, port })
  const localURLs = () => {
    const address = bound.server.address()
    if (address === null || typeof address === "string") return []
    const host = address.family === "IPv6" ? `[${address.address}]` : address.address
    return ServerInfo.connectionURLs(`http://${host}:${address.port}`, hostname)
  }
  const urls = () => [...localURLs(), ...(remoteURLs?.() ?? [])]
  const application = yield* Ref.make(Option.none<App>())
  // False while the scheduler's Redis cannot be reached, so /ready can take this layer out of rotation.
  const dependencies = yield* Ref.make(true)
  // Known once the services are built; lets this layer's managed global state be handed to a peer that is behind.
  const globalPaths = yield* Ref.make(Option.none<{ readonly config: string; readonly data: string }>())
  const auth = ServerAuth.Config.of({
    password: Option.some(password),
    gatewaySecret: options.gatewaySecret,
    gatewaySecretExtra: options.gatewaySecretExtra,
    defaultOrganization: options.defaultOrganization,
    guest: options.guest,
    uac: options.uac,
    username: "opencode",
  })
  const app = dispatch(auth, status, application, options.app?.version ?? "unknown", urls, Global.Path.tmp)
  // Request fibers may continue inbound trace context, but must not inherit the server startup parent.
  yield* bound.http
    .serve(
      probes(status, application, dependencies, globalPaths, auth, transform ? transform(app) : app).pipe(
        HttpMiddleware.compression(),
        HttpMiddleware.cors({ allowedOrigins: (origin) => isAllowedCorsOrigin(origin, options), maxAge: 86_400 }),
      ),
      errorResponseLogger,
    )
    .pipe(Effect.provide(NodeHttpServer.layerHttpServices), withoutParentSpan)
  if (lifecycle)
    yield* lifecycle.onListen(bound.http.address, shutdown.open.pipe(Effect.asVoid)).pipe(
      Effect.flatMap((cleanup) =>
        Effect.addFinalizer(() => Scope.close(bound.scope, Exit.void).pipe(Effect.andThen(cleanup))),
      ),
      Effect.uninterruptible,
    )

  const parentScope = yield* Scope.Scope
  const applicationScope = yield* Scope.fork(parentScope)
  // Set once this process is announced to the scheduler; resolves when it has stopped taking work and running sessions
  // have finished (or the drain timeout passed). Without a registry there is nothing to wait for.
  const settle = yield* Ref.make<Effect.Effect<void>>(Effect.void)
  yield* Effect.addFinalizer(() =>
    status.beginDraining.pipe(
      Effect.andThen(Ref.get(settle).pipe(Effect.flatMap((run) => run))),
      Effect.andThen(status.beginStopping),
      Effect.andThen(Ref.set(application, Option.none())),
      Effect.andThen(Effect.sync(() => bound.server.closeAllConnections())),
    ),
  )

  const boot = Effect.gen(function* () {
    const context = yield* Layer.buildWithScope(
      createRoutes(
        {
          ...options,
          password,
        },
        urls,
      ).pipe(Layer.provideMerge(NodeHttpServer.layerHttpServices)),
      applicationScope,
    )
    if (lifecycle) {
      yield* installRestartContinuity(Context.get(context, SessionRestart.Service)).pipe(
        Effect.provideService(Scope.Scope, applicationScope),
      )
    }
    yield* Ref.set(application, Option.some(Context.get(context, HttpRouter.HttpRouter).asHttpEffect()))
    yield* status.ready
    const global = Context.get(context, Global.Service)
    yield* Ref.set(globalPaths, Option.some({ config: global.config, data: global.data }))
    if (options.registry)
      yield* announce(
        options.registry,
        options.app?.version ?? "unknown",
        Context.get(context, SessionExecution.Service),
        settle,
        dependencies,
        { password, config: global.config, data: global.data },
      ).pipe(Effect.forkIn(applicationScope))
    const bus = Context.get(context, Bus.Service)
    return {
      address: bound.http.address,
      shutdown: shutdown.await,
      updateAvailable: (version: string) =>
        bus.publish(InstallationEvent.UpdateAvailable, { version }).pipe(Effect.asVoid),
      updated: (version: string) => bus.publish(InstallationEvent.Updated, { version }).pipe(Effect.asVoid),
    }
  }).pipe(
    Effect.catchCause((cause) => {
      if (!lifecycle || Cause.hasInterruptsOnly(cause)) return Effect.failCause(cause)
      return status.fail.pipe(
        Effect.andThen(
          Scope.close(applicationScope, Exit.failCause(cause)).pipe(
            Effect.catchCause((cleanupCause) =>
              Effect.logError("failed to clean up background service boot", { cause: cleanupCause }),
            ),
          ),
        ),
        Effect.andThen(Effect.logError("background service boot failed", { cause })),
        Effect.andThen(Effect.never),
      )
    }),
  )
  if (!lifecycle) return yield* boot
  return yield* Effect.raceFirst(boot, shutdown.await.pipe(Effect.andThen(Effect.interrupt)))
})

// Keeps this process in the scheduler's list while it is healthy. Load is the number of sessions running here, so new
// sessions go where there is room. On shutdown the process first stays listed but draining (no new organizations), waits
// for running sessions, and only then leaves the list.
function announce(
  registry: NonNullable<ServerOptions["registry"]>,
  version: string,
  execution: SessionExecution.Interface,
  settle: Ref.Ref<Effect.Effect<void>>,
  dependencies: Ref.Ref<boolean>,
  sync: { readonly password: string; readonly config: string; readonly data: string },
) {
  // Organizations stay pinned to a layer by this id, so it must be the same after a restart.
  const id = registry.id ?? registry.advertise
  const entry = { id, url: registry.advertise, version }
  return Effect.gen(function* () {
    const redis = yield* Effect.acquireRelease(Effect.sync(() => new RedisClient(registry.redis)), (client) =>
      Effect.promise(() => RuntimeRegistry.deregister(client, id)).pipe(Effect.ignore, Effect.andThen(Effect.sync(() => client.close()))),
    )
    yield* Effect.promise(() => RuntimeRegistry.register(redis, entry))
    Presence.shared.redis = redis
    const draining = yield* Ref.make(false)
    const idle = Effect.gen(function* () {
      while ((yield* execution.active).size > 0) yield* Effect.sleep(Duration.millis(500))
    })
    yield* Ref.set(
      settle,
      Ref.set(draining, true).pipe(
        Effect.andThen(Effect.promise(() => RuntimeRegistry.drain(redis, id))),
        Effect.andThen(idle.pipe(Effect.timeoutOption(Duration.millis(registry.drainTimeoutMs ?? DRAIN_TIMEOUT_MS)))),
        Effect.flatMap((finished) =>
          Option.isSome(finished) ? Effect.void : Effect.logWarning("drain timed out; interrupting running sessions"),
        ),
        Effect.catchCause((cause) => Effect.logWarning("runtime drain failed", { cause })),
      ),
    )
    yield* execution.active.pipe(
      Effect.flatMap((active) => Effect.promise(() => RuntimeRegistry.heartbeat(redis, id, active.size))),
      // A lease that already expired means Redis lost us (restart, partition); announce again.
      Effect.flatMap((alive) =>
        alive
          ? Effect.void
          : Effect.promise(() => RuntimeRegistry.register(redis, entry)).pipe(
              Effect.andThen(Ref.get(draining)),
              Effect.flatMap((again) => (again ? Effect.promise(() => RuntimeRegistry.drain(redis, id)) : Effect.void)),
            ),
      ),
      // The Redis client queues commands while it is disconnected instead of failing them, so an unanswered heartbeat
      // has to count as a failure or /ready would keep saying yes.
      Effect.timeout(Duration.seconds(3)),
      Effect.andThen(Ref.set(dependencies, true)),
      Effect.catchCause((cause) =>
        Effect.logWarning("runtime heartbeat failed", { cause }).pipe(Effect.andThen(Ref.set(dependencies, false))),
      ),
      Effect.andThen(
        Effect.promise(() => PackageSync.reconcile({ redis, id, ...sync })).pipe(
          Effect.timeout(Duration.seconds(90)),
          Effect.flatMap((result) =>
            result === "copied"
              ? Effect.logInfo("copied global packages and shared MCP servers from a peer layer")
              : result === "unavailable"
                ? Effect.logWarning("behind on global packages, but no layer has the latest to copy")
                : Effect.void,
          ),
          Effect.catchCause((cause) => Effect.logWarning("global package catch-up failed", { cause })),
        ),
      ),
      Effect.repeat({ schedule: Schedule.spaced(RuntimeRegistry.LEASE_MS / 3) }),
    )
  }).pipe(Effect.scoped, Effect.catchCause((cause) => Effect.logWarning("runtime registration failed", { cause })))
}

const DRAIN_TIMEOUT_MS = 30_000

function listen(options: { readonly hostname: string; readonly port: Option.Option<number> }) {
  if (Option.isSome(options.port)) return bind(options.hostname, options.port.value)
  const next = (port: number): ReturnType<typeof bind> =>
    bind(options.hostname, port).pipe(
      Effect.catch((error) => (port < 65_535 && addressInUse(error) ? next(port + 1) : Effect.fail(error))),
    )
  return next(4096)
}

function bind(hostname: string, port: number) {
  return Effect.gen(function* () {
    const parentScope = yield* Scope.Scope
    const serverScope = yield* Scope.fork(parentScope)
    const server = createServer()
    return yield* Effect.gen(function* () {
      const http = yield* NodeHttpServer.make(() => server, { port, host: hostname })
      yield* Effect.addFinalizer(() => Effect.sync(() => server.closeAllConnections()))
      return { http, server, scope: serverScope }
    }).pipe(
      Effect.provideService(Scope.Scope, serverScope),
      Effect.onError((cause) => Scope.close(serverScope, Exit.failCause(cause))),
    )
  })
}

function addressInUse(error: unknown) {
  if (typeof error !== "object" || error === null || !("cause" in error)) return false
  const cause = error.cause
  return typeof cause === "object" && cause !== null && "code" in cause && cause.code === "EADDRINUSE"
}

function dispatch(
  auth: ServerAuth.Info,
  status: Status.Interface,
  application: Ref.Ref<Option.Option<App>>,
  version: string,
  urls: () => ReadonlyArray<string>,
  tmp: string,
): App {
  const replays = ReplayGuard.make()
  return Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest
    const url = new URL(request.url, "http://localhost")
    const state = yield* status.current
    const app = yield* Ref.get(application)
    const ready = (state.type === "ready" || state.type === "draining") && Option.isSome(app)
    if (request.method === "GET" && url.pathname === "/api/info" && !ready) {
      if (!(yield* authorizedRequest(request, auth))) return unauthorizedResponse(request)
      return yield* infoResponse(status, version, urls, tmp)
    }
    if (ServerAuth.gatewayReplayed(request.headers, auth, replays))
      return HttpServerResponse.jsonUnsafe({ code: "gateway_replay" }, { status: 403 })
    const basic = /^Basic\s+/i.test(request.headers.authorization ?? "")
    const publicAuth =
      (request.method === "POST" &&
        (url.pathname === AUTH_REGISTER_PATH ||
          url.pathname === AUTH_LOGIN_PATH ||
          url.pathname === AUTH_GUEST_PATH ||
          url.pathname === AUTH_UAC_PATH)) ||
      (request.method === "GET" &&
        (url.pathname === AUTH_GUEST_CONFIG_PATH || url.pathname === AUTH_UAC_CONFIG_PATH))
    if (
      !isPairingConnectURL(url) &&
      !publicAuth &&
      !basic &&
      !ServerAuth.gatewayAccount(request.headers, auth) &&
      (!ready ||
        (!hasPtyConnectTicketURL(url) && !hasPersistentPtyConnectTicketURL(url) && !hasMcpClientTicketURL(url))) &&
      !(yield* authorizedRequest(request, auth))
    )
      return unauthorizedResponse(request)
    if (state.type === "draining" && startsWork(request.method, url.pathname)) return unavailable(state)
    if (!ready) return unavailable(state)
    // The gateway's id ties this layer's log lines to the request it forwarded.
    const requestID = request.headers["x-request-id"]?.slice(0, 64)
    return yield* requestID ? app.value.pipe(Effect.annotateLogs({ requestId: requestID })) : app.value
  })
}

const infoResponse = Effect.fnUntraced(function* (
  status: Status.Interface,
  version: string,
  urls: () => ReadonlyArray<string>,
  tmp: string,
) {
  const state = yield* status.current
  return HttpServerResponse.jsonUnsafe(
    { version, pid: process.pid, urls: urls(), paths: { tmp } },
    {
      status: state.type === "ready" ? 200 : state.type === "failed" ? 500 : 503,
      headers: state.type === "starting" || state.type === "stopping" ? { "retry-after": "1" } : undefined,
    },
  )
})

// A draining process keeps serving what is running, but must not take on new sessions or prompts.
const NEW_WORK = /^\/api\/session(\/[^/]+\/(prompt|command|shell))?\/?$/
function startsWork(method: string, pathname: string) {
  return method === "POST" && NEW_WORK.test(pathname)
}

// Probes carry no credentials and reveal nothing but whether this process should receive traffic. They sit outside the
// frontend transform, which would otherwise answer any non-API path with the web app.
function probes(
  status: Status.Interface,
  application: Ref.Ref<Option.Option<App>>,
  dependencies: Ref.Ref<boolean>,
  globalPaths: Ref.Ref<Option.Option<{ readonly config: string; readonly data: string }>>,
  auth: ServerAuth.Info,
  next: App,
): App {
  return Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest
    const pathname = new URL(request.url, "http://localhost").pathname
    // Peers that missed a global package change copy this layer's, so only the operator password opens it.
    if (request.method === "GET" && pathname === PackageSync.PATH) {
      const paths = yield* Ref.get(globalPaths)
      if (!(yield* authorizedRequest(request, auth)) || ServerAuth.gatewayAccount(request.headers, auth))
        return unauthorizedResponse(request)
      if (Option.isNone(paths)) return unavailable({ type: "starting" })
      return HttpServerResponse.uint8Array(
        yield* Effect.promise(() => GlobalSync.snapshot(paths.value.config, paths.value.data)),
        { contentType: "application/gzip" },
      )
    }
    if (request.method !== "GET" || (pathname !== "/health" && pathname !== "/ready")) return yield* next
    if (pathname === "/health") return HttpServerResponse.jsonUnsafe({ ok: true })
    const state = yield* status.current
    const serving = state.type === "ready" && Option.isSome(yield* Ref.get(application)) && (yield* Ref.get(dependencies))
    return HttpServerResponse.jsonUnsafe({ ok: serving, state: state.type }, { status: serving ? 200 : 503 })
  })
}

function unavailable(status: Status.State) {
  if (status.type === "failed")
    return HttpServerResponse.jsonUnsafe(
      {
        code: "service_failed",
        message: "The background service could not start.",
        action: "Run `opencode service restart` after checking the service logs.",
      },
      { status: 503 },
    )
  return HttpServerResponse.jsonUnsafe(
    { code: status.type === "stopping" ? "service_stopping" : status.type === "draining" ? "service_draining" : "service_starting" },
    { status: 503, headers: { "retry-after": "1" } },
  )
}

/**
 * The managed server owns restart continuity: at boot it resumes Sessions whose execution claim was
 * never released. Claims are written when execution starts (see SessionExecution), so recovery covers
 * graceful restarts and unclean deaths alike — no shutdown hook participates.
 */
const installRestartContinuity = Effect.fnUntraced(function* (restart: SessionRestart.Interface) {
  yield* Effect.forkScoped(restart.resumeSuspendedSessions)
})
