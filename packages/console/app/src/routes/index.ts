// The retained website entry opens the documentation instead of a marketing page.
export function GET() {
  return new Response(null, { status: 302, headers: { Location: "/v2/docs/" } })
}
