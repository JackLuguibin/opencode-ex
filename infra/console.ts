import { domain } from "./stage"

new sst.cloudflare.x.SolidStart("Console", {
  domain,
  path: "packages/console/app",
})
