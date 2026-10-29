import { domain } from "./stage"

const v2DocsUrl = process.env.OPENCODE_EX_V2_DOCS_URL
if (!v2DocsUrl) throw new Error("Set OPENCODE_EX_V2_DOCS_URL to the ex V2 documentation service before deployment")

new sst.cloudflare.x.SolidStart("Console", {
  domain,
  path: "packages/console/app",
  environment: {
    VITE_OPENCODE_EX_V2_DOCS_URL: v2DocsUrl,
  },
})
