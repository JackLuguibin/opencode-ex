export * as SessionRunnerModel from "./model.js"

import { makeLocationNode } from "@opencode/util/effect/app-node"
import { LanguageModel } from "@opencode/ai/effect"
import { Model } from "@opencode/schema/model"
import { Provider } from "@opencode/schema/provider"
import { Context, Effect, Layer, Schema } from "effect"
import { Agent } from "../../agent.js"
import { Credential } from "../../credential.js"
import { Identity } from "../../identity.js"
import { ModelPreference } from "../../model-preference.js"
import { ModelResolver } from "../../model-resolver.js"
import { SessionSchema } from "../schema.js"

export class ModelNotSelectedError extends Schema.TaggedError<ModelNotSelectedError>()(
  "SessionRunnerModel.ModelNotSelectedError",
  { sessionID: SessionSchema.ID },
) {
  override get message() {
    return `No model is available for session ${this.sessionID}`
  }
}

export class ModelUnavailableError extends Schema.TaggedError<ModelUnavailableError>()(
  "SessionRunnerModel.ModelUnavailableError",
  { providerID: Provider.ID, modelID: Model.ID },
) {
  override get message() {
    if (this.providerID === "azure-cognitive-services")
      return `Model unavailable: ${this.providerID}/${this.modelID}. This provider has been deprecated; use azure/${this.modelID} instead.`
    if (this.providerID === "google-vertex-anthropic")
      return `Model unavailable: ${this.providerID}/${this.modelID}. This provider has been deprecated; use google-vertex/${this.modelID} instead.`
    return `Model unavailable: ${this.providerID}/${this.modelID}`
  }
}
export type Error = ModelNotSelectedError | ModelUnavailableError | ModelResolver.Error
export type Resolved = ModelResolver.Resolved

export interface Interface {
  /** Availability is sampled lazily for each explicitly selected model resolution. */
  readonly resolve: (
    session: SessionSchema.Info,
    available: () => Effect.Effect<ReadonlyArray<Model.Info>>,
  ) => Effect.Effect<Resolved, Error>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SessionRunnerModel") {}

/** Builds a Resolved whose catalog identity mirrors the route model. Test or embedding seam. */
export const resolved = (
  model: LanguageModel,
  options: {
    readonly capabilities: Model.Capabilities
    readonly variant?: Model.VariantID
    readonly cost: Model.Info["cost"]
    readonly limit: Model.Info["limit"]
    readonly compaction?: Provider.Compaction
    readonly transport?: Provider.Transport
  },
): Resolved => ({
  model,
  ref: Model.Ref.make({
    id: Model.ID.make(model.id),
    providerID: Provider.ID.make(model.provider),
    ...(options.variant === undefined ? {} : { variant: options.variant }),
  }),
  capabilities: options.capabilities,
  cost: options.cost,
  limit: options.limit,
  compaction: options.compaction,
  transport: options.transport,
})

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const models = yield* ModelResolver.Service
    const agents = yield* Agent.Service
    const identity = yield* Identity.Service
    const preferences = yield* ModelPreference.Service
    return Service.of({
      resolve: Effect.fn("SessionRunnerModel.resolve")(function* (session, availableModels) {
        // Runs have no request behind them, so the user who last started or continued the session stands in as the
        // one whose personal credentials apply. Opening someone else's session and prompting it switches to yours.
        const user = yield* identity.sessionUser(session.id)
        const acting = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
          user ? Effect.provideService(effect, Credential.Actor, { userID: user, admin: false }) : effect
        const available = () => acting(availableModels())
        const resolver = {
          resolve: (...input: Parameters<ModelResolver.Interface["resolve"]>) => acting(models.resolve(...input)),
          resolveModel: (...input: Parameters<ModelResolver.Interface["resolveModel"]>) =>
            acting(models.resolveModel(...input)),
        }
        const selected = session.model
          ? (yield* available()).find(
              (model) => model.providerID === session.model?.providerID && model.id === session.model.id,
            )
          : undefined
        if (selected) return yield* resolver.resolveModel(selected, session.model?.variant)
        // The chosen model can exist only through another user's personal credentials or providers. A signed-in user
        // then falls back to their own default model, and after that to the agent's or the organization's, instead of
        // being stuck on it.
        if (session.model && !user)
          return yield* new ModelUnavailableError({
            providerID: session.model.providerID,
            modelID: session.model.id,
          })
        const own = user ? (yield* acting(preferences.read())).default : undefined
        const owned =
          own && (yield* available()).find((model) => model.providerID === own.providerID && model.id === own.modelID)
        if (owned) return yield* resolver.resolveModel(owned, own.variant ? Model.VariantID.make(own.variant) : undefined)
        // Location plugins populate and filter the catalog asynchronously during layer startup.
        const agent = (yield* agents.select(session.agent)).info?.model
        const preferred =
          agent && (yield* available()).find((model) => model.providerID === agent.providerID && model.id === agent.id)
        const resolved = preferred
          ? yield* resolver.resolveModel(preferred, agent.variant)
          : yield* resolver.resolve()
        if (resolved) return resolved
        return yield* new ModelNotSelectedError({ sessionID: session.id })
      }),
    })
  }),
)

export const node = makeLocationNode({ service: Service, layer, deps: [ModelResolver.node, Agent.node, Identity.node, ModelPreference.node] })
