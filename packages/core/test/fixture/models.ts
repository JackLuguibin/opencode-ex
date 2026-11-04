import { ModelsDev } from "@opencode/core/models-dev"

// Core is env-free, so the default ModelsDev node does not fetch. Real-Location
// fixtures keep the catalog offline explicitly; the test harness refuses any
// request that slips past.
export const offlineModels = ModelsDev.node.replace(ModelsDev.configured({ fetch: false }))
