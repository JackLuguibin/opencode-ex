import type { Credential } from "@opencode/core/credential"
import { InvalidRequestError } from "@opencode/protocol/errors"
import { Effect } from "effect"

const HEADER_NAME = /^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,100}$/
const INTEGRATION_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/i

/** Validates a custom provider definition, whoever is adding it. */
export const customProvider = Effect.fnUntraced(function* (
  id: string,
  input: {
    readonly name: string
    readonly baseURL: string
    readonly models: ReadonlyArray<string>
    readonly headers?: Readonly<Record<string, string>>
    readonly names?: Readonly<Record<string, string>>
  },
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
  const headers = Object.entries(input.headers ?? {}).map(([key, value]) => [key.trim(), value.trim()] as const)
  if (
    headers.length > 20 ||
    headers.some(([key, value]) => !HEADER_NAME.test(key) || value.length > 2000 || /[\r\n]/.test(value))
  )
    return yield* new InvalidRequestError({ message: "Check the headers", field: "headers" })
  // Names only matter for models the provider lists; a blank name falls back to the ID.
  const names = Object.entries(input.names ?? {}).flatMap(([id, label]) =>
    models.includes(id.trim()) && label.trim() ? [[id.trim(), label.trim().slice(0, 120)] as const] : [],
  )
  return {
    id: providerID,
    name,
    baseURL,
    models,
    ...(headers.length > 0 ? { headers: Object.fromEntries(headers) } : {}),
    ...(names.length > 0 ? { names: Object.fromEntries(names) } : {}),
  } satisfies Credential.CustomProvider
})
