import { define } from "@opencode/plugin/effect/plugin"
import { Effect, Stream } from "effect"
import { Credential } from "../../credential.js"
import { Integration } from "../../integration.js"
import { Model } from "../../model.js"

/**
 * Adds the OpenAI-compatible providers an admin defined for the organization that owns this Location. Their API keys
 * are ordinary credentials under the provider's ID, so organization members share the admin's key and can add
 * their own the same way as for any other provider. Members' own providers join the catalog under IDs that embed their
 * owner; with no credential but the owner's they are available to the owner alone.
 */
export const OrganizationProviderPlugin = define({
  id: "opencode.provider.organization",
  effect: Effect.fn(function* (ctx) {
    const credentials = yield* Credential.Service
    const loaded = { providers: [] as Credential.CatalogProvider[] }
    const refresh = credentials.catalogProviders().pipe(
      Effect.tap((providers) => Effect.sync(() => (loaded.providers = providers))),
      Effect.andThen(ctx.integration.reload()),
      Effect.andThen(ctx.provider.reload()),
    )
    yield* ctx.event
      .subscribe({ types: ["credential.updated"] })
      .pipe(Stream.runForEach(() => refresh), Effect.forkScoped({ startImmediately: true }))
    // Close the race between the first read and establishing the subscription.
    loaded.providers = yield* credentials.catalogProviders()

    yield* ctx.integration.transform((integrations) => {
      for (const provider of loaded.providers) {
        const integrationID = Integration.ID.make(provider.id)
        if (!integrations.get(integrationID))
          integrations.method.update({ integrationID, method: { type: "key", label: "Manually enter API Key" } })
        integrations.update(integrationID, (integration) => {
          integration.name = provider.name
        })
      }
    })

    yield* ctx.provider.transform((providers) => {
      for (const provider of loaded.providers) {
        providers.update(provider.id, (item) => {
          item.name = provider.name
          item.package = "@opencode/ai/providers/openai-compatible"
          item.settings = { baseURL: provider.baseURL, provider: provider.id }
          item.integrationID = Integration.ID.make(provider.id)
        })
        for (const modelID of provider.models) {
          providers.models.update(provider.id, modelID, (model) => {
            model.modelID = Model.ID.make(modelID)
            model.name = modelID
            model.capabilities = { tools: true, input: ["text"], output: ["text"] }
          })
        }
      }
    })
  }),
})
