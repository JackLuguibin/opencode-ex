import { domain } from "./stage"

const GITHUB_APP_ID = new sst.Secret("GITHUB_APP_ID")
const GITHUB_APP_PRIVATE_KEY = new sst.Secret("GITHUB_APP_PRIVATE_KEY")
const ADMIN_SECRET = new sst.Secret("ADMIN_SECRET")

export const api = new sst.cloudflare.Worker("Api", {
  domain: domain ? `api.${domain}` : undefined,
  handler: "packages/function/src/api.ts",
  url: true,
  link: [GITHUB_APP_ID, GITHUB_APP_PRIVATE_KEY, ADMIN_SECRET],
  transform: {
    worker: (args) => {
      args.logpush = true
    },
  },
})
