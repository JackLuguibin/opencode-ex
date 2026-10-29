import type { Credential } from "@opencode/core/credential"
import { InvalidRequestError } from "@opencode/protocol/errors"
import { Effect } from "effect"

const INTEGRATION_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/i

/** Validates a custom provider definition, whoever is adding it. */
export const customProvider = Effect.fnUntraced(function* (
  id: string,
  input: { readonly name: string; readonly baseURL: string; readonly models: ReadonlyArray<string> },
) {
  const providerID = id.trim()
  // The "personal." prefix is how the catalog tells a member's own providers apart; nothing else may claim it.
  if (!INTEGRATION_ID.test(providerID) || providerID.toLowerCase().startsWith("personal."))
    return yield* new InvalidRequestError({ message: "Check the provider ID", field: "providerID" })
  const name = input.name.trim()
  if (!name || name.length > 80) return yield* new InvalidRequestError({ message: "Enter a name", field: "name" })
  const baseURL = input.baseURL.trim().replace(/\/+$/, "")
  const url = URL.canParse(baseURL) ? new URL(baseURL) : undefined
  if (!url || (url.protocol !== "http:" && url.protocol !== "https:"))
    return yield* new InvalidRequestError({ message: "Enter an http or https base URL", field: "baseURL" })
  const models = [...new Set(input.models.map((model) => model.trim()).filter(Boolean))]
  if (models.length === 0 || models.length > 200 || models.some((model) => model.length > 200))
    return yield* new InvalidRequestError({ message: "Enter at least one model", field: "models" })
  return { id: providerID, name, baseURL, models } satisfies Credential.CustomProvider
})
