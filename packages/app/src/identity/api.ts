export type AccountSession = {
  readonly employeeID: string
  readonly admin: boolean
  readonly organizationID?: string
  /** Directory that holds the current organization's projects. */
  readonly organizationDirectory?: string
  readonly organizations: ReadonlyArray<{ readonly id: string; readonly name: string }>
}

export type AccountOrganization = {
  readonly id: string
  readonly name: string
  readonly members: ReadonlyArray<string>
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
