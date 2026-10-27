import schema from "../../../../protocol/openapi.json" with { type: "json" }

export function GET() {
  return Response.json(schema)
}
