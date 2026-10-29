import { expect } from "bun:test"
import { LanguageModel } from "@opencode/ai/effect"
import { OpenAIChat } from "@opencode/ai/protocols/openai-chat"
import { Agent } from "@opencode/core/agent"
import { Credential } from "@opencode/core/credential"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { Identity } from "@opencode/core/identity"
import { Location } from "@opencode/core/location"
import { Model } from "@opencode/core/model"
import { ModelPreference } from "@opencode/core/model-preference"
import { ModelResolver } from "@opencode/core/model-resolver"
import { Project } from "@opencode/core/project"
import { Provider } from "@opencode/core/provider"
import { AbsolutePath } from "@opencode/core/schema"
import { Session } from "@opencode/core/session"
import { SessionRunnerModel } from "@opencode/core/session/runner/model"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { Money } from "@opencode/schema/money"
import { DateTime, Effect, Layer, Option } from "effect"
import { location } from "./fixture/location"
import { it } from "./lib/effect"

const ref = location({ directory: AbsolutePath.make("test") })
const organization = Model.ID.make("org-model")
const alice = { providerID: Provider.ID.make("personal.usr_alice.mine"), id: Model.ID.make("alice-model") }
const bob = { providerID: Provider.ID.make("personal.usr_bob.mine"), id: Model.ID.make("bob-model") }
const shared = { providerID: Provider.ID.make("acme"), id: organization }

const acting = Effect.serviceOption(Credential.Actor).pipe(Effect.map((actor) => Option.getOrThrow(actor)))

// Who holds the session, and which models each member can reach and prefers.
const state = { holder: "usr_alice" as string | undefined }
const available: Record<string, Array<{ providerID: Provider.ID; id: Model.ID }>> = {
  usr_alice: [alice, shared],
  usr_bob: [bob, shared],
  usr_carol: [shared],
}
const defaults: Record<string, { providerID: string; modelID: string } | undefined> = {
  usr_alice: { providerID: alice.providerID, modelID: alice.id },
  usr_bob: { providerID: bob.providerID, modelID: bob.id },
}

const layer = AppNodeBuilder.build(LayerNode.group([SessionRunnerModel.node]), [
  Location.node.replace(Layer.succeed(Location.Service, Location.Service.of(ref))),
  Identity.node.replace(
    Layer.succeed(Identity.Service, { sessionUser: () => Effect.succeed(state.holder) } as unknown as Identity.Interface),
  ),
  Agent.node.replace(
    Layer.succeed(Agent.Service, { select: () => Effect.succeed({ info: undefined }) } as unknown as Agent.Interface),
  ),
  ModelPreference.node.replace(
    Layer.succeed(ModelPreference.Service, {
      read: () =>
        Effect.gen(function* () {
          const actor = yield* acting
          const chosen = defaults[actor.userID]
          return { hidden: [], shown: [], favorite: [], recent: [], ...(chosen ? { default: chosen } : {}) }
        }),
      write: () => Effect.void,
    }),
  ),
  ModelResolver.node.replace(
    Layer.succeed(ModelResolver.Service, {
      // The resolved model reports which model it is, which is all these tests look at.
      resolve: () => Effect.succeed(undefined),
      resolveModel: (model: Model.Info) =>
        Effect.gen(function* () {
          const actor = yield* acting
          return SessionRunnerModel.resolved(
            LanguageModel.make({ id: `${actor.userID}:${model.id}`, provider: model.providerID, route: OpenAIChat.route }),
            {
              capabilities: { tools: true, input: ["text"], output: ["text"] },
              cost: [],
              limit: { context: 200_000, output: 32_000 },
            },
          )
        }),
    } as unknown as ModelResolver.Interface),
  ),
])

const session = (model?: { providerID: Provider.ID; id: Model.ID }) =>
  Session.Info.make({
    id: Session.ID.make("ses_holder"),
    projectID: Project.ID.global,
    title: "test",
    ...(model ? { model } : {}),
    cost: Money.USD.zero,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: DateTime.makeUnsafe(0), updated: DateTime.makeUnsafe(0) },
    location: ref,
  })

const run = (holder: string, model?: { providerID: Provider.ID; id: Model.ID }) =>
  Effect.gen(function* () {
    state.holder = holder
    const runner = yield* SessionRunnerModel.Service
    const models = (userID: string) =>
      Effect.succeed(
        (available[userID] ?? []).map((item) => ({ ...item, enabled: true }) as unknown as Model.Info),
      ).pipe(Effect.map((items) => items as ReadonlyArray<Model.Info>))
    // `available` is evaluated under the holder, like the real catalog, so it follows who is acting.
    const catalog = () =>
      Effect.gen(function* () {
        const actor = yield* acting
        return yield* models(actor.userID)
      })
    return String((yield* runner.resolve(session(model), catalog)).model.id)
  }).pipe(Effect.provide(layer))

it.effect("a session continued by someone else runs on the new holder's models", () =>
  Effect.gen(function* () {
    // Alice starts on her own provider's model, and it keeps running for her.
    expect(yield* run("usr_alice", alice)).toBe(`usr_alice:${alice.id}`)
    // Bob continues it: Alice's personal provider is not his, so it runs on his default, with his configuration.
    expect(yield* run("usr_bob", alice)).toBe(`usr_bob:${bob.id}`)
    // A model both can reach stays as it is for whoever holds the session.
    expect(yield* run("usr_bob", shared)).toBe(`usr_bob:${organization}`)
    // Alice takes it back and gets hers again.
    expect(yield* run("usr_alice", alice)).toBe(`usr_alice:${alice.id}`)
  }),
)

it.effect("a holder with no default of their own falls back past the previous holder's models", () =>
  Effect.gen(function* () {
    // Carol has no personal provider and no default; the organization's model is all she can reach.
    const error = yield* run("usr_carol", alice).pipe(Effect.flip)
    expect(error._tag).toBe("SessionRunnerModel.ModelNotSelectedError")
  }),
)
