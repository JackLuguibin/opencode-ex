import { HttpApiMiddleware } from "effect/http-api"
import { ForbiddenError, SessionNotFoundError, UnauthorizedError } from "../errors.js"

export class Authorization extends HttpApiMiddleware.Service<Authorization>()("@opencode/HttpApiAuthorization", {
  error: [UnauthorizedError, ForbiddenError, SessionNotFoundError],
}) {}
