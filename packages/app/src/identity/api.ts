export type AccountSession = {
  readonly employeeID: string
  /** Display name; the employee ID stands in when there is none. */
  readonly name?: string
  readonly admin: boolean
  readonly organizationID?: string
  /** Manages the current organization: its admin, or a platform admin. */
  readonly organizationAdmin: boolean
  /** Directory that holds the current organization's projects. */
  readonly organizationDirectory?: string
  /** Settings pages the account can open. */
  readonly settingsPages: ReadonlyArray<string>
  readonly organizations: ReadonlyArray<{ readonly id: string; readonly name: string }>
}

export type AccountUser = {
  readonly employeeID: string
  readonly name?: string
  readonly admin: boolean
}

/** One administrative action, as the audit log keeps it. */
export type AccountAudit = {
  readonly id: string
  readonly actor: string
  readonly action: string
  readonly target?: string
  readonly detail?: string
  readonly time: number
}

export type AccountCredential = {
  readonly id: string
  readonly integrationID: string
  readonly label: string
  readonly active: boolean
  readonly type: "key" | "oauth" | "external"
}

export type AccountCustomProvider = {
  readonly id: string
  readonly name: string
  readonly baseURL: string
  readonly models: ReadonlyArray<string>
  readonly headers?: Readonly<Record<string, string>>
  readonly names?: Readonly<Record<string, string>>
}

/** A skill or plugin package every organization can use; `enabled` is for the signed-in organization. */
export type AccountPackage = {
  readonly kind: "skill" | "plugin"
  readonly name: string
  readonly description: string
  readonly size: number
  readonly uploadedBy: string
  readonly uploadedAt: number
  /** Organizations the package is open to; only platform admins are told. */
  readonly organizations: ReadonlyArray<string>
  readonly enabled: boolean
}

/** An MCP server a platform admin opened to some organizations; secrets are never listed. */
export type AccountSharedMcp = {
  readonly name: string
  readonly type: "local" | "remote"
  /** URL or command line; only platform admins are told. */
  readonly target: string
  readonly createdBy: string
  readonly createdAt: number
  /** Organizations it is open to; only platform admins are told. */
  readonly organizations: ReadonlyArray<string>
  readonly enabled: boolean
}

/** Who owns a session or project and whether the caller may change it. */
export type AccountAccessInfo = {
  /** Employee ID of the creator; empty when it isn't known. */
  readonly owner: string
  readonly visibility: "organization" | "private"
  readonly canManage: boolean
}

export type AccountJoinRequest = {
  readonly id: string
  readonly organizationID: string
  readonly organizationName: string
  readonly employeeID: string
  readonly name?: string
  readonly note?: string
  readonly status: "pending" | "approved" | "rejected"
  readonly time: number
}

export type AccountOrganization = {
  readonly id: string
  readonly name: string
  readonly members: ReadonlyArray<string>
  /** Display names of the members who have one, by employee ID. */
  readonly names: Readonly<Record<string, string>>
  /** Members who manage the organization. */
  readonly admins: ReadonlyArray<string>
  /** Settings pages ordinary members can open. */
  readonly settingsPages: ReadonlyArray<string>
  /** Whether the organization's sessions are copied to the shared Postgres; absent without one. */
  readonly sessionSync?: boolean
}

export class AccountError extends Error {
  readonly status: number

  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

export async function accountFetch<T>(input: {
  readonly url: string
  readonly password?: string
  readonly path: string
  readonly method?: string
  readonly body?: unknown
}): Promise<T> {
  let response: Response
  try {
    response = await fetch(new URL(input.path, input.url), {
      method: input.method ?? (input.body === undefined ? "GET" : "POST"),
      headers: {
        ...(input.body === undefined ? {} : { "content-type": "application/json" }),
        ...(input.password ? { authorization: `Basic ${btoa(`opencode:${input.password}`)}` } : {}),
      },
      body: input.body === undefined ? undefined : JSON.stringify(input.body),
    })
  } catch {
    throw new AccountError(0, "")
  }

  if (response.status === 204) return undefined as T
  const payload = (await response.json().catch(() => undefined)) as { message?: unknown } | undefined
  if (!response.ok) {
    throw new AccountError(response.status, typeof payload?.message === "string" ? payload.message : "")
  }
  return payload as T
}
