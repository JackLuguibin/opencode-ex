/// <reference path="./.sst/platform/config.d.ts" />

export default $config({
  app(input) {
    return {
      name: "opencode-ex",
      removal: input?.stage === "production" ? "retain" : "remove",
      protect: ["production"].includes(input?.stage),
      home: "cloudflare",
      providers: { cloudflare: "6.15.0" },
    }
  },
  async run() {
    const { api } = await import("./infra/app.js")
    await import("./infra/console.js")
    const { createWebApp } = await import("./infra/webapp.js")

    return {
      ApiUrl: api.url,
      WebAppUrl: createWebApp(process.env.OPENCODE_EX_WEB_DOMAIN).url,
    }
  },
})
