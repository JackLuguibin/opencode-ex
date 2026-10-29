import { Credential } from "@opencode/schema/credential"
import { Schema } from "effect"
import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema, OpenApi } from "effect/http-api"
import { ConflictError, ForbiddenError, InvalidRequestError } from "../errors.js"

const PreferenceRef = Schema.Struct({
  providerID: Schema.String,
  modelID: Schema.String,
  variant: Schema.optional(Schema.String),
}).annotate({ identifier: "ModelPreference.Ref" })

/** A member's own hidden, favorite and recent models and default model, kept on the server so they follow the account. */
export const ModelPreference = Schema.Struct({
  hidden: Schema.Array(PreferenceRef),
  shown: Schema.Array(PreferenceRef),
  favorite: Schema.Array(PreferenceRef),
  /** Most recently used first. */
  recent: Schema.Array(PreferenceRef),
  default: Schema.optional(PreferenceRef),
}).annotate({ identifier: "ModelPreference" })

export const ModelPreferencePatch = Schema.Struct({
  hidden: Schema.optional(Schema.Array(PreferenceRef)),
  shown: Schema.optional(Schema.Array(PreferenceRef)),
  favorite: Schema.optional(Schema.Array(PreferenceRef)),
  recent: Schema.optional(Schema.Array(PreferenceRef)),
  default: Schema.optional(Schema.NullOr(PreferenceRef)),
}).annotate({ identifier: "ModelPreferencePatch" })

export const CredentialGroup = HttpApiGroup.make("server.credential")
  .add(
    HttpApiEndpoint.get("credential.list", "/api/credential", {
      success: Schema.Struct({ data: Schema.Array(Credential.Entry) }),
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "credential.list",
        summary: "List credentials",
        description: "List every stored integration credential, including its secret value.",
      }),
    ),
  )
  .add(
    HttpApiEndpoint.post("credential.create", "/api/credential", {
      payload: Credential.CreateInput,
      success: Schema.Struct({ data: Credential.Entry }),
      error: [ConflictError, ForbiddenError],
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "credential.create",
        summary: "Create credential",
        description:
          "Store an integration credential. It becomes the integration's active credential unless activate is false and the integration already has one. Fails with a conflict when the requested ID already exists.",
      }),
    ),
  )
  .add(
    HttpApiEndpoint.patch("credential.update", "/api/credential/:credentialID", {
      params: { credentialID: Credential.ID },
      payload: Schema.Struct({ label: Schema.String }),
      success: HttpApiSchema.NoContent,
      error: ForbiddenError,
    })
      .annotateMerge(
        OpenApi.annotations({
          identifier: "credential.update",
          summary: "Update credential",
          description: "Update a stored credential label.",
        }),
      ),
  )
  .add(
    HttpApiEndpoint.get("scopes.get", "/api/credential/scopes", {
      success: Schema.Struct({
        data: Schema.Struct({ organization: Schema.Array(Schema.String), personal: Schema.Array(Schema.String) }),
      }),
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "scopes.get",
        summary: "Get provider scopes",
        description:
          "List the integrations the signed-in member's organization configured and the ones the member connected themselves, without any secret. An integration in neither is global.",
      }),
    ),
  )
  .add(
    HttpApiEndpoint.get("customProvider.list", "/api/custom-provider", {
      success: Schema.Struct({ data: Schema.Array(Credential.PersonalProvider) }),
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "customProvider.list",
        summary: "List personal providers",
        description: "List the OpenAI-compatible providers the signed-in member added for themselves.",
      }),
    ),
  )
  .add(
    HttpApiEndpoint.put("customProvider.save", "/api/custom-provider/:providerID", {
      params: { providerID: Schema.String },
      payload: Credential.PersonalProviderInput,
      success: Schema.Struct({ data: Credential.PersonalProvider }),
      error: [InvalidRequestError, ConflictError],
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "customProvider.save",
        summary: "Save personal provider",
        description:
          "Create or replace one of the member's own providers. A key in the payload is stored as the member's own credential for it.",
      }),
    ),
  )
  .add(
    HttpApiEndpoint.delete("customProvider.remove", "/api/custom-provider/:providerID", {
      params: { providerID: Schema.String },
      success: HttpApiSchema.NoContent,
      error: InvalidRequestError,
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "customProvider.remove",
        summary: "Remove personal provider",
        description: "Remove one of the member's own providers together with their credentials for it.",
      }),
    ),
  )
  .add(
    HttpApiEndpoint.get("modelPreference.get", "/api/model/preference", {
      success: Schema.Struct({ data: ModelPreference }),
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "modelPreference.get",
        summary: "Get model preferences",
        description:
          "Retrieve the signed-in member's hidden, favorite and recent models and default model in their organization.",
      }),
    ),
  )
  .add(
    HttpApiEndpoint.put("modelPreference.update", "/api/model/preference", {
      payload: ModelPreferencePatch,
      success: Schema.Struct({ data: ModelPreference }),
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "modelPreference.update",
        summary: "Update model preferences",
        description:
          "Replace each list present in the payload and leave the others as they are. A null default clears it.",
      }),
    ),
  )
  .annotateMerge(OpenApi.annotations({ title: "credential" }))
  .add(
    HttpApiEndpoint.post("credential.activate", "/api/credential/:credentialID/activate", {
      params: { credentialID: Credential.ID },
      success: HttpApiSchema.NoContent,
      error: ForbiddenError,
    })
      .annotateMerge(
        OpenApi.annotations({
          identifier: "credential.activate",
          summary: "Activate credential",
          description: "Activate a stored integration credential.",
        }),
      ),
  )
  .add(
    HttpApiEndpoint.delete("credential.remove", "/api/credential/:credentialID", {
      params: { credentialID: Credential.ID },
      success: HttpApiSchema.NoContent,
      error: ForbiddenError,
    })
      .annotateMerge(
        OpenApi.annotations({
          identifier: "credential.remove",
          summary: "Remove credential",
          description: "Remove a stored integration credential.",
        }),
      ),
  )
