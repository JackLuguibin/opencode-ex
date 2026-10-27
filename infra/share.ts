import { shortDomain } from "./stage"

new sst.cloudflare.Worker("Share", {
  domain: shortDomain,
  handler: "packages/function/src/share.ts",
})
