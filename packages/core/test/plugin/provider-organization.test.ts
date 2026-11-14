import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { Credential } from "@opencode/core/credential"
import { Database } from "@opencode/core/database/database"
import { IdentityOrganizationTable } from "@opencode/core/identity/sql"
import { Integration } from "@opencode/core/integration"
import { Location } from "@opencode/core/location"
import { Model } from "@opencode/core/model"
import { Plugin } from "@opencode/core/plugin"
import { PluginHost } from "@opencode/core/plugin/host"
import { OrganizationProviderPlugin } from "@opencode/core/plugin/provider/organization"
import { ProjectTable } from "@opencode/core/project/sql"
import { Provider } from "@opencode/core/provider"
import { testEffect } from "../lib/effect"
import { PluginTestLayer } from "./fixture"

const it = testEffect(PluginTestLayer)

describe("OrganizationProviderPlugin", () => {
  for (const scope of ["organization", "global"] as const)
    it.effect(`requires a connection before offering ${scope} preset models`, () =>
      Effect.gen(function* () {
        const credentials = yield* Credential.Service
        const db = (yield* Database.Service).db
        const location = yield* Location.Service
        const integrations = yield* Integration.Service
        const providers = yield* Provider.Service
        const models = yield* Model.Service
        const plugins = yield* Plugin.Service
        yield* db.insert(IdentityOrganizationTable).values({ id: "org_presets", name: "Presets" }).run()
        yield* db
          .insert(ProjectTable)
          .values({
            id: location.project.id,
            worktree: location.directory,
            sandboxes: [],
            organization_id: "org_presets",
          })
          .run()
        const preset = { id: "lab", name: "Lab", baseURL: "https://lab.test/v1", models: ["chat"] }
        if (scope === "global") yield* credentials.saveGlobalProvider(preset)
        if (scope === "organization") yield* credentials.saveCustomProvider("org_presets", preset)
        const providerID = Provider.ID.make(
          scope === "global"
            ? Credential.globalProviderID(preset.id)
            : Credential.organizationProviderID("org_presets", preset.id),
        )
        const host = yield* PluginHost.make(plugins)
        yield* OrganizationProviderPlugin.effect(host)

        expect((yield* integrations.list()).find((item) => item.id === Integration.ID.make(providerID))?.methods).toEqual([
          { type: "key", label: "Manually enter API Key" },
        ])
        expect(yield* providers.get(providerID)).toBeDefined()
        expect(yield* models.available()).toEqual([])

        const credential = yield* credentials.create({
          integrationID: Integration.ID.make(providerID),
          value: Credential.Key.make({ type: "key", key: "secret" }),
        })
        expect((yield* models.available()).map((model) => [model.providerID, model.id])).toEqual([
          [providerID, Model.ID.make("chat")],
        ])

        yield* credentials.remove(credential.id)
        expect(yield* models.available()).toEqual([])
      }),
    )
})
