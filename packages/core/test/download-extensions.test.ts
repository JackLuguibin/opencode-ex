import { expect, test } from "bun:test"
import { DEFAULT_DOWNLOAD_EXTENSIONS, downloadAllowed, normalizeExtensions } from "../src/identity/shared"

test("extensions are normalized and invalid ones rejected", () => {
  expect(normalizeExtensions([" .MD", "txt", "md", ""])).toEqual(["md", "txt"])
  expect(normalizeExtensions([])).toEqual([])
  expect(normalizeExtensions(["*"])).toEqual(["*"])
  expect(normalizeExtensions(["a/b"])).toBeUndefined()
  expect(normalizeExtensions(["*.exe"])).toBeUndefined()
})

test("downloads follow the allow-list by the last extension", () => {
  expect(downloadAllowed(["*"], "run.sh")).toBe(true)
  expect(downloadAllowed(["md", "png"], "docs/Readme.MD")).toBe(true)
  expect(downloadAllowed(["md"], "a.md.exe")).toBe(false)
  expect(downloadAllowed(["md"], "Makefile")).toBe(false)
  expect(downloadAllowed(["md"], ".env")).toBe(false)
  expect(downloadAllowed([], "a.md")).toBe(false)
})

test("the defaults allow text formats and not programs", () => {
  expect(downloadAllowed(DEFAULT_DOWNLOAD_EXTENSIONS, "notes.txt")).toBe(true)
  expect(downloadAllowed(DEFAULT_DOWNLOAD_EXTENSIONS, "setup.sh")).toBe(false)
  expect(downloadAllowed(DEFAULT_DOWNLOAD_EXTENSIONS, "app.exe")).toBe(false)
})
