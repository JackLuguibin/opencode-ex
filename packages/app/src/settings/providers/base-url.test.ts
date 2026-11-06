import { expect, test } from "bun:test"
import { missingVersion } from "./base-url"

test("flags a base URL without an API version segment", () => {
  expect(missingVersion("https://api.example.com")).toBe(true)
  expect(missingVersion("https://api.example.com/")).toBe(true)
  expect(missingVersion("https://api.example.com/api")).toBe(true)
  expect(missingVersion("  http://localhost:11434  ")).toBe(true)
})

test("accepts versioned paths in the shapes providers use", () => {
  expect(missingVersion("https://api.example.com/v1")).toBe(false)
  expect(missingVersion("https://api.example.com/v1/")).toBe(false)
  expect(missingVersion("https://open.bigmodel.cn/api/paas/v4")).toBe(false)
  expect(missingVersion("https://generativelanguage.googleapis.com/v1beta/openai")).toBe(false)
  expect(missingVersion("http://localhost:11434/v1")).toBe(false)
})

test("stays quiet while the URL is empty or not yet valid", () => {
  expect(missingVersion("")).toBe(false)
  expect(missingVersion("api.example.com")).toBe(false)
  expect(missingVersion("https://")).toBe(false)
})
