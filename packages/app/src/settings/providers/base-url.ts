/**
 * Whether an OpenAI-compatible base URL has no API version segment such as `/v1`. Requests go to
 * `<base URL>/chat/completions`, so `https://api.example.com` reaches a 404 while `https://api.example.com/v1` works.
 * Providers differ (`/v1`, `/v4`, `/api/paas/v4`), so this only prompts a warning and never blocks saving.
 */
export function missingVersion(baseURL: string) {
  const text = baseURL.trim()
  if (!URL.canParse(text)) return false
  return !/(^|\/)v\d+[a-z]*\d*(\/|$)/i.test(new URL(text).pathname)
}
