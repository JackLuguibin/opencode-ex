import { expect, test } from "bun:test"
import { zip } from "../src/zip"
import { readZip } from "./zip-read"

test("round-trips stored, deflated, empty, and unicode archive entries", () => {
  const text = "hello zip ".repeat(50)
  const bytes = zip(
    [
      { name: "note.txt", bytes: new TextEncoder().encode("hi") },
      { name: "dir/" },
      { name: "dir/long.txt", bytes: new TextEncoder().encode(text) },
      { name: "目录/文件.txt", bytes: new TextEncoder().encode("中文") },
      { name: "empty.txt", bytes: new Uint8Array() },
    ],
    new Date("2020-01-02T03:04:05Z"),
  )
  const entries = new Map(readZip(bytes).map((entry) => [entry.name, new TextDecoder().decode(entry.bytes)]))

  expect(entries.get("note.txt")).toBe("hi")
  expect(entries.get("dir/")).toBe("")
  expect(entries.get("dir/long.txt")).toBe(text)
  expect(entries.get("目录/文件.txt")).toBe("中文")
  expect(entries.get("empty.txt")).toBe("")
})

test("rejects archive paths that would escape when unzipped", () => {
  expect(() => zip([{ name: "../secret.txt", bytes: new Uint8Array() }])).toThrow("Unsafe archive path")
  expect(() => zip([{ name: "/etc/passwd", bytes: new Uint8Array() }])).toThrow("Unsafe archive path")
})
