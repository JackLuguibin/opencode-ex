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
  /** Whether the account manages the current organization: its admin, or a platform admin. */
  organizationAdmin: Schema.Boolean,
  /** Directory that holds the current organization's projects; users can't browse or create outside it. */
  organizationDirectory: Schema.optional(Schema.String),
  /** Settings pages this account can open. */
  settingsPages: Schema.Array(Schema.String),
  organizations: Schema.Array(OrganizationRef),
}).annotate({ identifier: "AuthSession" })
export interface AuthSession extends Schema.Schema.Type<typeof AuthSession> {}

export const AuthUser = Schema.Struct({
  employeeID: Schema.String,
  admin: Schema.Boolean,
}).annotate({ identifier: "AuthUser" })
export interface AuthUser extends Schema.Schema.Type<typeof AuthUser> {}

/** A model credential shared by an organization. Secrets never leave the server through this listing. */
export const AuthOrganizationCredential = Schema.Struct({
  id: Schema.String,
  integrationID: Schema.String,
  label: Schema.String,
  active: Schema.Boolean,
  type: Schema.Literals(["key", "oauth", "external"]),
}).annotate({ identifier: "AuthOrganizationCredential" })
export interface AuthOrganizationCredential extends Schema.Schema.Type<typeof AuthOrganizationCredential> {}

/** A skill or plugin package every organization can use; `enabled` is for the caller's current organization. */
export const AuthPackage = Schema.Struct({
  kind: Schema.Literals(["skill", "plugin"]),
  name: Schema.String,
  description: Schema.String,
  size: Schema.Number,
  uploadedBy: Schema.String,
  uploadedAt: Schema.Number,
  /** Organizations the package is open to. Only platform admins are told; everyone else gets an empty list. */
  organizations: Schema.Array(Schema.String),
  enabled: Schema.Boolean,
}).annotate({ identifier: "AuthPackage" })
export interface AuthPackage extends Schema.Schema.Type<typeof AuthPackage> {}

/** An MCP server a platform admin opened to some organizations. Secrets (headers, environment) are never listed. */
export const AuthSharedMcp = Schema.Struct({
  name: Schema.String,
  type: Schema.Literals(["local", "remote"]),
  /** The URL or command line; only platform admins are told. */
  target: Schema.String,
  createdBy: Schema.String,
  createdAt: Schema.Number,
  /** Organizations it is open to; only platform admins are told. */
  organizations: Schema.Array(Schema.String),
  enabled: Schema.Boolean,
}).annotate({ identifier: "AuthSharedMcp" })
export interface AuthSharedMcp extends Schema.Schema.Type<typeof AuthSharedMcp> {}

/** An OpenAI-compatible provider defined for one organization. */
export const AuthCustomProvider = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  baseURL: Schema.String,
  models: Schema.Array(Schema.String),
}).annotate({ identifier: "AuthCustomProvider" })
export interface AuthCustomProvider extends Schema.Schema.Type<typeof AuthCustomProvider> {}

export const AuthOrganization = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  members: Schema.Array(Schema.String),
  /** Members who manage the organization. */
  admins: Schema.Array(Schema.String),
  /** Settings pages ordinary members of the organization can open. */
  settingsPages: Schema.Array(Schema.String),
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
      success: Schema.Array(AuthUser),
      error: [ForbiddenError, UnauthorizedError],
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "auth.user.list",
        summary: "List registered users",
        description: "List registered employee IDs and whether each is a platform admin. Only a platform admin can call this.",
      }),
    ),
  )
  .add(
    HttpApiEndpoint.post("auth.user.create", "/api/auth/users", {
      payload: Schema.Struct({
        employeeID: Schema.String,
        password: Schema.String,
        admin: Schema.optional(Schema.Boolean),
        organizationID: Schema.optional(Schema.String),
      }),
      success: AuthUser,
      error: [ForbiddenError, InvalidRequestError, UnauthorizedError],
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "auth.user.create",
        summary: "Create user",
        description:
          "Register an employee ID with a password, optionally as a platform admin or as a member of an organization. Only a platform admin can call this.",
      }),
    ),
  )
  .add(
    HttpApiEndpoint.delete("auth.user.delete", "/api/auth/users/:employeeID", {
      params: { employeeID: Schema.String },
      success: HttpApiSchema.NoContent,
      error: [ForbiddenError, InvalidRequestError, UnauthorizedError],
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "auth.user.delete",
        summary: "Delete user",
        description:
          "Remove an employee ID with its sessions and memberships. Admins can't delete themselves. Only a platform admin can call this.",
      }),
    ),
  )
  .add(
    HttpApiEndpoint.put("auth.user.admin", "/api/auth/users/:employeeID/admin", {
      params: { employeeID: Schema.String },
      payload: Schema.Struct({ admin: Schema.Boolean }),
      success: AuthUser,
      error: [ForbiddenError, InvalidRequestError, UnauthorizedError],
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "auth.user.admin",
        summary: "Set user role",
        description:
          "Grant or withdraw platform admin. Admins can't change their own role. Only a platform admin can call this.",
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
        description: "List every organization and its members for a platform admin, or the organizations the signed-in employee administers. Anyone else gets an empty list.",
      }),
    ),
  )
  .add(
    HttpApiEndpoint.patch("auth.organization.rename", "/api/organization/:organizationID", {
      params: { organizationID: Schema.String },
      payload: Schema.Struct({ name: Schema.String }),
      success: AuthOrganization,
      error: [ForbiddenError, InvalidRequestError, UnauthorizedError],
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "auth.organization.rename",
        summary: "Rename organization",
        description: "Change an organization's name. Only a platform admin can call this.",
      }),
    ),
  )
  .add(
    HttpApiEndpoint.post("auth.user.password", "/api/auth/users/:employeeID/password", {
      params: { employeeID: Schema.String },
      payload: Schema.Struct({ password: Schema.String }),
      success: HttpApiSchema.NoContent,
      error: [ForbiddenError, InvalidRequestError, UnauthorizedError],
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "auth.user.password",
        summary: "Reset user password",
        description:
          "Set a new password for an employee ID and sign that employee out everywhere. Only a platform admin can call this.",
      }),
    ),
  )
  .add(
    HttpApiEndpoint.get("auth.organization.credential.list", "/api/organization/:organizationID/credential", {
      params: { organizationID: Schema.String },
      success: Schema.Array(AuthOrganizationCredential),
      error: [ForbiddenError, InvalidRequestError, UnauthorizedError],
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "auth.organization.credential.list",
        summary: "List organization model credentials",
        description:
          "List the model credentials an organization shares with all its members and projects, without their secrets. Only a platform admin or an admin of that organization can call this.",
      }),
    ),
  )
  .add(
    HttpApiEndpoint.post("auth.organization.credential.create", "/api/organization/:organizationID/credential", {
      params: { organizationID: Schema.String },
      payload: Schema.Struct({
        integrationID: Schema.String,
        key: Schema.String,
        label: Schema.optional(Schema.String),
      }),
      success: AuthOrganizationCredential,
      error: [ForbiddenError, InvalidRequestError, UnauthorizedError],
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "auth.organization.credential.create",
        summary: "Add organization model credential",
        description:
          "Store an API key for a provider integration and share it with the organization. It becomes the integration's selected credential for the organization. Only a platform admin or an admin of that organization can call this.",
      }),
    ),
  )
  .add(
    HttpApiEndpoint.post(
      "auth.organization.credential.activate",
      "/api/organization/:organizationID/credential/:credentialID/activate",
      {
        params: { organizationID: Schema.String, credentialID: Schema.String },
        success: HttpApiSchema.NoContent,
        error: [ForbiddenError, InvalidRequestError, UnauthorizedError],
      },
    ).annotateMerge(
      OpenApi.annotations({
        identifier: "auth.organization.credential.activate",
        summary: "Select organization model credential",
        description: "Make a shared credential the one the organization uses for its integration. Only a platform admin or an admin of that organization can call this.",
      }),
    ),
  )
  .add(
    HttpApiEndpoint.delete(
      "auth.organization.credential.remove",
      "/api/organization/:organizationID/credential/:credentialID",
      {
        params: { organizationID: Schema.String, credentialID: Schema.String },
        success: HttpApiSchema.NoContent,
        error: [ForbiddenError, InvalidRequestError, UnauthorizedError],
      },
    ).annotateMerge(
      OpenApi.annotations({
        identifier: "auth.organization.credential.remove",
        summary: "Remove organization model credential",
        description: "Delete a shared credential. Only a platform admin or an admin of that organization can call this.",
      }),
    ),
  )
  .add(
    HttpApiEndpoint.get("auth.organization.provider.list", "/api/organization/:organizationID/provider", {
      params: { organizationID: Schema.String },
      success: Schema.Array(AuthCustomProvider),
      error: [ForbiddenError, InvalidRequestError, UnauthorizedError],
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "auth.organization.provider.list",
        summary: "List organization custom providers",
        description: "List the OpenAI-compatible providers defined for an organization. Only a platform admin or an admin of that organization can call this.",
      }),
    ),
  )
  .add(
    HttpApiEndpoint.put("auth.organization.provider.save", "/api/organization/:organizationID/provider/:providerID", {
      params: { organizationID: Schema.String, providerID: Schema.String },
      payload: Schema.Struct({
        name: Schema.String,
        baseURL: Schema.String,
        models: Schema.Array(Schema.String),
        key: Schema.optional(Schema.String),
      }),
      success: AuthCustomProvider,
      error: [ForbiddenError, InvalidRequestError, UnauthorizedError],
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "auth.organization.provider.save",
        summary: "Save organization custom provider",
        description:
          "Create or replace an OpenAI-compatible provider for an organization. A key, when given, is stored as the organization's shared credential for it. Only a platform admin or an admin of that organization can call this.",
      }),
    ),
  )
  .add(
    HttpApiEndpoint.delete(
      "auth.organization.provider.remove",
      "/api/organization/:organizationID/provider/:providerID",
      {
        params: { organizationID: Schema.String, providerID: Schema.String },
        success: HttpApiSchema.NoContent,
        error: [ForbiddenError, InvalidRequestError, UnauthorizedError],
      },
    ).annotateMerge(
      OpenApi.annotations({
        identifier: "auth.organization.provider.remove",
        summary: "Remove organization custom provider",
        description:
          "Delete an organization's custom provider and every credential for it in that organization. Only a platform admin or an admin of that organization can call this.",
      }),
    ),
  )
  .add(
    HttpApiEndpoint.get("auth.package.list", "/api/package", {
      success: Schema.Array(AuthPackage),
      error: [UnauthorizedError],
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "auth.package.list",
        summary: "List global packages",
        description: "Skill and plugin packages uploaded by platform admins, with whether the current organization uses each.",
      }),
    ),
  )
  .add(
    HttpApiEndpoint.post("auth.package.upload", "/api/package", {
      payload: Schema.Struct({
        kind: Schema.Literals(["skill", "plugin"]),
        name: Schema.String,
        /** The package as a zip archive, base64 encoded. */
        archive: Schema.String,
        /** Organizations the package is open to; the rest can't see or use it. */
        organizations: Schema.Array(Schema.String),
      }),
      success: AuthPackage,
      error: [ForbiddenError, InvalidRequestError, UnauthorizedError],
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "auth.package.upload",
        summary: "Upload a global package",
        description: "Install or replace a skill or plugin package for every organization. Only a platform admin can call this.",
      }),
    ),
  )
  .add(
    HttpApiEndpoint.delete("auth.package.remove", "/api/package/:kind/:name", {
      params: { kind: Schema.Literals(["skill", "plugin"]), name: Schema.String },
      success: HttpApiSchema.NoContent,
      error: [ForbiddenError, InvalidRequestError, UnauthorizedError],
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "auth.package.remove",
        summary: "Delete a global package",
        description: "Remove a package uploaded earlier. Only a platform admin can call this.",
      }),
    ),
  )
  .add(
    HttpApiEndpoint.put("auth.package.scope", "/api/package/:kind/:name/organizations", {
      params: { kind: Schema.Literals(["skill", "plugin"]), name: Schema.String },
      payload: Schema.Struct({ organizations: Schema.Array(Schema.String) }),
      success: HttpApiSchema.NoContent,
      error: [ForbiddenError, InvalidRequestError, UnauthorizedError],
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "auth.package.scope",
        summary: "Choose the organizations a global package is open to",
        description: "Only a platform admin can call this.",
      }),
    ),
  )
  .add(
    HttpApiEndpoint.get("auth.mcp.list", "/api/shared-mcp", {
      success: Schema.Array(AuthSharedMcp),
      error: [UnauthorizedError],
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "auth.mcp.list",
        summary: "List shared MCP servers",
        description: "MCP servers platform admins opened to the caller's organization (all of them for a platform admin).",
      }),
    ),
  )
  .add(
    HttpApiEndpoint.post("auth.mcp.create", "/api/shared-mcp", {
      payload: Schema.Struct({
        name: Schema.String,
        type: Schema.Literals(["local", "remote"]),
        url: Schema.optional(Schema.String),
        headers: Schema.optional(Schema.Record(Schema.String, Schema.String)),
        command: Schema.optional(Schema.Array(Schema.String)),
        environment: Schema.optional(Schema.Record(Schema.String, Schema.String)),
        organizations: Schema.Array(Schema.String),
      }),
      success: AuthSharedMcp,
      error: [ForbiddenError, InvalidRequestError, UnauthorizedError],
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "auth.mcp.create",
        summary: "Create a shared MCP server",
        description: "Only a platform admin can call this. A local server runs a command on the server.",
      }),
    ),
  )
  .add(
    HttpApiEndpoint.delete("auth.mcp.remove", "/api/shared-mcp/:name", {
      params: { name: Schema.String },
      success: HttpApiSchema.NoContent,
      error: [ForbiddenError, InvalidRequestError, UnauthorizedError],
    }).annotateMerge(
      OpenApi.annotations({ identifier: "auth.mcp.remove", summary: "Delete a shared MCP server" }),
    ),
  )
  .add(
    HttpApiEndpoint.put("auth.mcp.scope", "/api/shared-mcp/:name/organizations", {
      params: { name: Schema.String },
      payload: Schema.Struct({ organizations: Schema.Array(Schema.String) }),
      success: HttpApiSchema.NoContent,
      error: [ForbiddenError, InvalidRequestError, UnauthorizedError],
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "auth.mcp.scope",
        summary: "Choose the organizations a shared MCP server is open to",
      }),
    ),
  )
  .add(
    HttpApiEndpoint.put("auth.organization.mcp", "/api/organization/:organizationID/shared-mcp/:name", {
      params: { organizationID: Schema.String, name: Schema.String },
      payload: Schema.Struct({ enabled: Schema.Boolean }),
      success: HttpApiSchema.NoContent,
      error: [ForbiddenError, InvalidRequestError, UnauthorizedError],
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "auth.organization.mcp",
        summary: "Switch a shared MCP server on or off for an organization",
        description: "Only a platform admin or an admin of that organization can call this.",
      }),
    ),
  )
  .add(
    HttpApiEndpoint.put("auth.organization.package", "/api/organization/:organizationID/package/:kind/:name", {
      params: { organizationID: Schema.String, kind: Schema.Literals(["skill", "plugin"]), name: Schema.String },
      payload: Schema.Struct({ enabled: Schema.Boolean }),
      success: HttpApiSchema.NoContent,
      error: [ForbiddenError, InvalidRequestError, UnauthorizedError],
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "auth.organization.package",
        summary: "Switch a global package on or off for an organization",
        description:
          "Only a platform admin or an admin of that organization can call this. Plugins take effect the next time a project loads.",
      }),
    ),
  )
  .add(
    HttpApiEndpoint.put("auth.organization.settings", "/api/organization/:organizationID/settings", {
      params: { organizationID: Schema.String },
      payload: Schema.Struct({ pages: Schema.Array(Schema.String) }),
      success: AuthOrganization,
      error: [ForbiddenError, InvalidRequestError, UnauthorizedError],
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "auth.organization.settings",
        summary: "Set organization settings pages",
        description:
          "Choose the settings pages ordinary members of an organization can open. Only a platform admin or an admin of that organization can call this.",
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
        description: "Add a registered employee ID to an organization. Only a platform admin or an admin of that organization can call this.",
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
        description: "Remove an employee ID from an organization. Only a platform admin or an admin of that organization can call this.",
      }),
    ),
  )
  .add(
    HttpApiEndpoint.put("auth.organization.member.role", "/api/organization/:organizationID/member/:employeeID/role", {
      params: { organizationID: Schema.String, employeeID: Schema.String },
      payload: Schema.Struct({ role: Schema.Literals(["admin", "member"]) }),
      success: AuthOrganization,
      error: [ForbiddenError, InvalidRequestError, UnauthorizedError],
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "auth.organization.member.role",
        summary: "Set organization member role",
        description:
          "Make a member an admin of their organization, or an ordinary member again. Only a platform admin can call this.",
      }),
    ),
  )
  .annotateMerge(OpenApi.annotations({ title: "auth" }))
