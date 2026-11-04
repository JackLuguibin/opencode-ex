const client = {
  auth: {
    set: async () => ({ data: true }),
  },
  global: {
    dispose: async () => ({ data: true }),
  },
}

const api = {
  session: {
    form: {
      reply: async () => ({ data: true }),
      cancel: async () => ({ data: true }),
    },
  },
}

export function useServerSDK() {
  return {
    scope: ServerScope.local,
    url: "http://storybook.local",
    api,
    client,
  }
}
import { ServerScope } from "@/runtime/server/scope"
