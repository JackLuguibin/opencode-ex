/* Local resource declarations matching infra/. Regenerate with SST when configuring a deployment. */
/* tslint:disable */
/* eslint-disable */
/* deno-fmt-ignore-file */
/* biome-ignore-all lint: auto-generated */

declare module "sst" {
  export interface Resource {
    "ADMIN_SECRET": {
      "type": "sst.sst.Secret"
      "value": string
    }
    "Api": import("@cloudflare/workers-types").Service
    "Console": {
      "type": "sst.cloudflare.SolidStart"
      "url": string
    }
    "GITHUB_APP_ID": {
      "type": "sst.sst.Secret"
      "value": string
    }
    "GITHUB_APP_PRIVATE_KEY": {
      "type": "sst.sst.Secret"
      "value": string
    }
    "Share": import("@cloudflare/workers-types").Service
    "Web": {
      "type": "sst.cloudflare.Astro"
      "url": string
    }
    "WebApp": {
      "type": "sst.cloudflare.StaticSiteV2"
      "url": string
    }
  }
}

import "sst"
export {}