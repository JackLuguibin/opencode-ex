import type { IntegrationMethod } from "@opencode/client/promise"

type ProviderAuthMethod = Extract<IntegrationMethod, { type: "key" | "oauth" }>

const data = {
  provider: {
    all: new Map(),
    connected: [],
    default: {},
  },
  provider_auth: {} as Record<string, ProviderAuthMethod[]>,
  config: { disabled_providers: [] as string[] },
}
