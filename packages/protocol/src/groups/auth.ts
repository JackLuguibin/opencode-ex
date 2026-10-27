import { Schema } from "effect"
import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema, OpenApi } from "effect/http-api"
import { ForbiddenError, InvalidRequestError, UnauthorizedError } from "../errors.js"

export const AUTH_REGISTER_PATH = "/api/auth/register"
export const AUTH_LOGIN_PATH = "/api/auth/login"

const Credentials = Schema.Struct({
  employeeID: Schema.String,
  password: Schema.String,
})

const Token = Schema.Struct({
  token: Schema.String,
}).annotate({ identifier: "AuthToken" })

const OrganizationRef = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
}).annotate({ identifier: "AuthOrganization" })

export const AuthSession = Schema.Struct({
  employeeID: Schema.String,
  admin: Schema.Boolean,
  organizationID: Schema.optional(Schema.String),
  organizations: Schema.Array(OrganizationRef),
}).annotate({ identifier: "AuthSession" })
export interface AuthSession extends Schema.Schema.Type<typeof AuthSession> {}

export const AuthOrganization = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  members: Schema.Array(Schema.String),
}).annotate({ identifier: "AuthOrganizationDetail" })
export interface AuthOrganization extends Schema.Schema.Type<typeof AuthOrganization> {}

export const AuthGroup = HttpApiGroup.make("server.auth")
  .add(
    HttpApiEndpoint.post("auth.register", AUTH_REGISTER_PATH, {
      payload: Credentials,
      success: Token,
      error: InvalidRequestError,
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "auth.register",
        summary: "Register",
        description: "Create an employee ID account. Registration does not create an organization.",
      }),
    ),
  )
  .add(
    HttpApiEndpoint.post("auth.login", AUTH_LOGIN_PATH, {
      payload: Credentials,
      success: Token,
      error: UnauthorizedError,
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "auth.login",
        summary: "Log in",
        description: "Exchange an employee ID and password for a session token.",
      }),
    ),
  )
  .add(
    HttpApiEndpoint.post("auth.logout", "/api/auth/logout", {
      success: HttpApiSchema.NoContent,
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "auth.logout",
        summary: "Log out",
        description: "Revoke the current user session token.",
      }),
    ),
  )
  .add(
    HttpApiEndpoint.get("auth.session", "/api/auth/session", {
      success: AuthSession,
      error: UnauthorizedError,
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "auth.session",
        summary: "Current session",
        description: "Return the signed-in employee, admin flag, and organization memberships.",
      }),
    ),
  )
  .add(
    HttpApiEndpoint.get("auth.user.list", "/api/auth/users", {
      success: Schema.Array(Schema.String),
      error: [ForbiddenError, UnauthorizedError],
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "auth.user.list",
        summary: "List registered users",
        description: "List registered employee IDs. Only a platform admin can call this.",
      }),
    ),
  )
  .add(
    HttpApiEndpoint.post("auth.switch", "/api/auth/organization", {
      payload: Schema.Struct({ organizationID: Schema.String }),
      success: AuthSession,
      error: [InvalidRequestError, UnauthorizedError],
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "auth.switch",
        summary: "Switch organization",
        description: "Select one of the signed-in user's organizations for this session.",
      }),
    ),
  )
  .add(
    HttpApiEndpoint.post("auth.organization.create", "/api/organization", {
      payload: Schema.Struct({ name: Schema.String }),
      success: AuthOrganization,
      error: [ForbiddenError, InvalidRequestError, UnauthorizedError],
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "auth.organization.create",
        summary: "Create organization",
        description: "Create an organization. Only a platform admin can call this.",
      }),
    ),
  )
  .add(
    HttpApiEndpoint.get("auth.organization.list", "/api/organization", {
      success: Schema.Array(AuthOrganization),
      error: [ForbiddenError, InvalidRequestError, UnauthorizedError],
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "auth.organization.list",
        summary: "List organizations",
        description: "List every organization and its members. Only a platform admin can call this.",
      }),
    ),
  )
  .add(
    HttpApiEndpoint.post("auth.organization.member.add", "/api/organization/:organizationID/member", {
      params: { organizationID: Schema.String },
      payload: Schema.Struct({ employeeID: Schema.String }),
      success: AuthOrganization,
      error: [ForbiddenError, InvalidRequestError, UnauthorizedError],
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "auth.organization.member.add",
        summary: "Add organization member",
        description: "Add a registered employee ID to an organization. Only a platform admin can call this.",
      }),
    ),
  )
  .add(
    HttpApiEndpoint.delete("auth.organization.member.remove", "/api/organization/:organizationID/member/:employeeID", {
      params: { organizationID: Schema.String, employeeID: Schema.String },
      success: AuthOrganization,
      error: [ForbiddenError, InvalidRequestError, UnauthorizedError],
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "auth.organization.member.remove",
        summary: "Remove organization member",
        description: "Remove an employee ID from an organization. Only a platform admin can call this.",
      }),
    ),
  )
  .annotateMerge(OpenApi.annotations({ title: "auth" }))
