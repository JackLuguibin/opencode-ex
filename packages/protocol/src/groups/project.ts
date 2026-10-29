import { Project } from "@opencode/schema/project"
import { Schema, SchemaGetter, Struct } from "effect"
import { HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/http-api"
import { ForbiddenError, InvalidRequestError, ProjectNotFoundError } from "../errors.js"

const root = "/api/project"
const UpdatePayload = Schema.Struct(Struct.omit(Project.UpdateInput.fields, ["projectID"]))
const BooleanFromString = Schema.Literals(["true", "false"]).pipe(
  Schema.decodeTo(Schema.Boolean, {
    decode: SchemaGetter.transform((value) => value === "true"),
    encode: SchemaGetter.transform((value): "true" | "false" => (value ? "true" : "false")),
  }),
)

export const ProjectGroup = HttpApiGroup.make("server.project")
  .add(
    HttpApiEndpoint.get("project.list", root, {
      query: Schema.Struct({ archived: BooleanFromString.pipe(Schema.optional) }),
      success: Schema.Array(Project.Info),
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "project.list",
        summary: "List projects",
        description: "List known projects. Archived projects are excluded unless archived=true.",
      }),
    ),
  )
  .add(
    HttpApiEndpoint.patch("project.update", `${root}/:projectID`, {
      params: { projectID: Project.ID },
      payload: UpdatePayload,
      success: Project.Info,
      error: [ProjectNotFoundError, ForbiddenError],
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "project.update",
        summary: "Update project",
        description:
          "Update the project canonical directory, display metadata, and workspace commands. Setting archived hides it from lists, or brings it back, without touching its sessions or folder; in an organization only an admin can.",
      }),
    ),
  )
  .add(
    HttpApiEndpoint.delete("project.remove", `${root}/:projectID`, {
      params: { projectID: Project.ID },
      success: Schema.Struct({
        files: Schema.Boolean.annotate({ description: "Whether the project folder was deleted from disk too." }),
      }),
      error: [ProjectNotFoundError, InvalidRequestError, ForbiddenError],
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "project.remove",
        summary: "Delete project",
        description:
          "Delete a project with all its sessions. In an organization only an admin can. A folder inside its organization's directory is deleted from disk too; other folders are left alone. An organization's default directory can't be deleted.",
      }),
    ),
  )
  .annotateMerge(
    OpenApi.annotations({
      title: "project",
      description: "Project routes.",
    }),
  )
