import { domain } from "./stage"

// Archived Zen request/response dumps (writer removed May 2026). Retained on purpose; nothing reads or writes them.
new sst.cloudflare.Bucket("ZenData")
new sst.cloudflare.Bucket("ZenDataNew")

new sst.cloudflare.x.SolidStart("Console", {
  domain,
  path: "packages/console/app",
  transform: {
    server: {
      placement: { region: "aws:us-east-2" },
      transform: {
        worker: (args) => {
          args.compatibilityFlags = $resolve(args.compatibilityFlags).apply((flags) => [
            ...(flags ?? []),
            "global_fetch_strictly_public",
          ])
        },
      },
    },
  },
})
