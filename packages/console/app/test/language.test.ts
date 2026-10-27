import { describe, expect, test } from "bun:test"
import { LOCALE_HEADER, pageLocale, route } from "../src/lib/language"

describe("language.route", () => {
  test("prefixes localized documentation routes", () => {
    expect(route("de", "/docs/agents")).toBe("/docs/de/agents")
  })
})

describe("pageLocale", () => {
  const request = (path: string, headers: Record<string, string> = {}) =>
    new Request(`https://opencode.ai${path}`, { headers })
  const german = { "accept-language": "de-DE,de;q=0.9", cookie: "oc_locale=de" }

  test("ignores the browser language and cookie on unprefixed pages", () => {
    expect(pageLocale(request("/", german))).toBe("en")
    expect(pageLocale(request("/docs/agents/", german))).toBe("en")
  })

  test("uses the locale in the URL", () => {
    expect(pageLocale(request("/", { [LOCALE_HEADER]: "de" }))).toBe("de")
    expect(pageLocale(request("/docs/de/agents/"))).toBe("de")
  })
})
