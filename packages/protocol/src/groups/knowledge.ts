import { Schema } from "effect"
import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema, OpenApi } from "effect/http-api"
import { ForbiddenError, InvalidRequestError, LocationNotFoundError, ServiceUnavailableError, UnauthorizedError } from "../errors.js"

// The knowledge service owns the shape of these bodies; the execution layer checks who is asking and forwards them, so
// they are not described here beyond being JSON.
const errors = [UnauthorizedError, ForbiddenError, InvalidRequestError, ServiceUnavailableError] as const
const note = (identifier: string, summary: string) =>
  OpenApi.annotations({ identifier: `knowledge.${identifier}`, summary, description: summary })

export const KnowledgeGroup = HttpApiGroup.make("server.knowledge")
  .add(HttpApiEndpoint.get("knowledge.bases.list", "/api/knowledge/bases", { success: Schema.Unknown, error: errors }).annotateMerge(note("bases.list", "List knowledge bases")))
  .add(HttpApiEndpoint.post("knowledge.bases.create", "/api/knowledge/bases", { payload: Schema.Unknown, success: Schema.Unknown, error: errors }).annotateMerge(note("bases.create", "Create a knowledge base")))
  .add(HttpApiEndpoint.get("knowledge.bases.get", "/api/knowledge/bases/:baseID", { params: { baseID: Schema.String }, success: Schema.Unknown, error: errors }).annotateMerge(note("bases.get", "Get a knowledge base")))
  .add(HttpApiEndpoint.patch("knowledge.bases.update", "/api/knowledge/bases/:baseID", { params: { baseID: Schema.String }, payload: Schema.Unknown, success: Schema.Unknown, error: errors }).annotateMerge(note("bases.update", "Rename a knowledge base")))
  .add(HttpApiEndpoint.delete("knowledge.bases.delete", "/api/knowledge/bases/:baseID", { params: { baseID: Schema.String }, success: HttpApiSchema.NoContent, error: errors }).annotateMerge(note("bases.delete", "Delete a knowledge base")))
  .add(HttpApiEndpoint.put("knowledge.bases.grant", "/api/knowledge/bases/:baseID/grants", { params: { baseID: Schema.String }, payload: Schema.Unknown, success: Schema.Unknown, error: errors }).annotateMerge(note("bases.grant", "Set the organizations a knowledge base is open to")))
  .add(HttpApiEndpoint.get("knowledge.bases.stats", "/api/knowledge/bases/:baseID/stats", { params: { baseID: Schema.String }, success: Schema.Unknown, error: errors }).annotateMerge(note("bases.stats", "Index status of a knowledge base")))
  .add(HttpApiEndpoint.post("knowledge.bases.reindex", "/api/knowledge/bases/:baseID/reindex", { params: { baseID: Schema.String }, success: Schema.Unknown, error: errors }).annotateMerge(note("bases.reindex", "Rebuild the vector index of a knowledge base")))
  .add(HttpApiEndpoint.get("knowledge.bases.settings.get", "/api/knowledge/bases/:baseID/settings", { params: { baseID: Schema.String }, success: Schema.Unknown, error: errors }).annotateMerge(note("bases.settings.get", "Read the settings of a knowledge base")))
  .add(HttpApiEndpoint.patch("knowledge.bases.settings.update", "/api/knowledge/bases/:baseID/settings", { params: { baseID: Schema.String }, payload: Schema.Unknown, success: Schema.Unknown, error: errors }).annotateMerge(note("bases.settings.update", "Change the settings of a knowledge base")))
  .add(HttpApiEndpoint.get("knowledge.entries.list", "/api/knowledge/bases/:baseID/entries", { params: { baseID: Schema.String }, query: { q: Schema.optional(Schema.String), status: Schema.optional(Schema.String), limit: Schema.optional(Schema.String), offset: Schema.optional(Schema.String) }, success: Schema.Unknown, error: errors }).annotateMerge(note("entries.list", "List entries")))
  .add(HttpApiEndpoint.get("knowledge.entries.count", "/api/knowledge/bases/:baseID/entries/count", { params: { baseID: Schema.String }, query: { q: Schema.optional(Schema.String), status: Schema.optional(Schema.String) }, success: Schema.Unknown, error: errors }).annotateMerge(note("entries.count", "Count the entries a list would page through")))
  .add(HttpApiEndpoint.post("knowledge.entries.create", "/api/knowledge/bases/:baseID/entries", { params: { baseID: Schema.String }, payload: Schema.Unknown, success: Schema.Unknown, error: errors }).annotateMerge(note("entries.create", "Add entries")))
  .add(HttpApiEndpoint.post("knowledge.entries.status", "/api/knowledge/bases/:baseID/status", { params: { baseID: Schema.String }, payload: Schema.Unknown, success: Schema.Unknown, error: errors }).annotateMerge(note("entries.status", "Publish or hide entries")))
  .add(HttpApiEndpoint.get("knowledge.entries.get", "/api/knowledge/entries/:entryID", { params: { entryID: Schema.String }, success: Schema.Unknown, error: errors }).annotateMerge(note("entries.get", "Get an entry")))
  .add(HttpApiEndpoint.patch("knowledge.entries.update", "/api/knowledge/entries/:entryID", { params: { entryID: Schema.String }, payload: Schema.Unknown, success: Schema.Unknown, error: errors }).annotateMerge(note("entries.update", "Change an entry")))
  .add(HttpApiEndpoint.delete("knowledge.entries.delete", "/api/knowledge/entries/:entryID", { params: { entryID: Schema.String }, success: HttpApiSchema.NoContent, error: errors }).annotateMerge(note("entries.delete", "Delete an entry")))
  .add(HttpApiEndpoint.post("knowledge.search", "/api/knowledge/search", { payload: Schema.Unknown, success: Schema.Unknown, error: errors }).annotateMerge(note("search", "Search knowledge")))
  .add(HttpApiEndpoint.get("knowledge.settings.get", "/api/knowledge/settings", { success: Schema.Unknown, error: errors }).annotateMerge(note("settings.get", "Read the platform knowledge settings")))
  .add(HttpApiEndpoint.patch("knowledge.settings.update", "/api/knowledge/settings", { payload: Schema.Unknown, success: Schema.Unknown, error: errors }).annotateMerge(note("settings.update", "Change the platform knowledge settings")))
  .add(HttpApiEndpoint.get("knowledge.models", "/api/knowledge/models", { success: Schema.Unknown, error: errors }).annotateMerge(note("models", "Shared chat and embedding models a knowledge base can use")))
  .add(HttpApiEndpoint.post("knowledge.vectorStore.test", "/api/knowledge/vector-store/test", { payload: Schema.Unknown, success: Schema.Unknown, error: errors }).annotateMerge(note("vectorStore.test", "Test a vector store connection")))
  .add(HttpApiEndpoint.get("knowledge.eval.cases", "/api/knowledge/bases/:baseID/eval/cases", { params: { baseID: Schema.String }, success: Schema.Unknown, error: errors }).annotateMerge(note("eval.cases", "List evaluation cases")))
  .add(HttpApiEndpoint.post("knowledge.eval.addCase", "/api/knowledge/bases/:baseID/eval/cases", { params: { baseID: Schema.String }, payload: Schema.Unknown, success: Schema.Unknown, error: errors }).annotateMerge(note("eval.addCase", "Add an evaluation case")))
  .add(HttpApiEndpoint.delete("knowledge.eval.removeCase", "/api/knowledge/eval/cases/:caseID", { params: { caseID: Schema.String }, success: HttpApiSchema.NoContent, error: errors }).annotateMerge(note("eval.removeCase", "Remove an evaluation case")))
  .add(HttpApiEndpoint.get("knowledge.eval.runs", "/api/knowledge/bases/:baseID/eval/runs", { params: { baseID: Schema.String }, success: Schema.Unknown, error: errors }).annotateMerge(note("eval.runs", "List evaluation runs")))
  .add(HttpApiEndpoint.post("knowledge.eval.run", "/api/knowledge/bases/:baseID/eval/run", { params: { baseID: Schema.String }, success: Schema.Unknown, error: errors }).annotateMerge(note("eval.run", "Run the evaluation cases")))
  .add(HttpApiEndpoint.post("knowledge.import.start", "/api/knowledge/bases/:baseID/import", { params: { baseID: Schema.String }, payload: Schema.Unknown, success: Schema.Unknown, error: [...errors, LocationNotFoundError] }).annotateMerge(note("import.start", "Convert a Markdown document into entries")))
  .add(HttpApiEndpoint.get("knowledge.import.job", "/api/knowledge/jobs/:jobID", { params: { jobID: Schema.String }, success: Schema.Unknown, error: errors }).annotateMerge(note("import.job", "Read the progress of an import")))
  .annotateMerge(OpenApi.annotations({ title: "knowledge", description: "Knowledge bases the AI can look things up in." }))
