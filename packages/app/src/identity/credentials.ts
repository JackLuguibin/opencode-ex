import type { ServerConnection } from "@/runtime/server/registry"
import { accountFetch } from "./api"

/** Credential IDs the server gives a key that applies in every organization; they are not rows of its database. */
const GLOBAL_PREFIX = "cred_global."

export type UserCredentials = {
  readonly enabled: boolean
  readonly items: ReadonlyArray<{ readonly integrationID: string; readonly hint: string }>
}

export const isGlobalCredential = (credentialID: string) => credentialID.startsWith(GLOBAL_PREFIX)

export const globalCredentialIntegration = (credentialID: string) => credentialID.slice(GLOBAL_PREFIX.length)

const request = (server: ServerConnection.Http, path: string, method?: string, body?: unknown) =>
  accountFetch<never>({ url: server.http.url, password: server.http.password, path, method, body })

export const listUserCredentials = (server: ServerConnection.Http) =>
  accountFetch<UserCredentials>({ url: server.http.url, password: server.http.password, path: "/api/auth/credentials" })

export const saveUserCredential = (server: ServerConnection.Http, integrationID: string, key: string) =>
  request(server, `/api/auth/credentials/${encodeURIComponent(integrationID)}`, "PUT", { key })

export const removeUserCredential = (server: ServerConnection.Http, integrationID: string) =>
  request(server, `/api/auth/credentials/${encodeURIComponent(integrationID)}`, "DELETE")
