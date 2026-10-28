import { describe, expect, test } from "bun:test"
import { ZipArchive } from "@opencode/core/zip-archive"
import { zip } from "./lib/zip"

const limits = { files: 10, bytes: 1024 }

describe("ZipArchive.read", () => {
  test("reads stored and deflated files", () => {
    const entries = ZipArchive.read(
      zip([
        { name: "SKILL.md", data: "hello" },
        { name: "scripts/run.sh", data: "echo ".repeat(40), deflate: true },
      ]),
      limits,
    )

    expect(entries.map((entry) => [entry.path, Buffer.from(entry.data).toString().slice(0, 5)])).toEqual([
      ["SKILL.md", "hello"],
      ["scripts/run.sh", "echo "],
    ])
  })

  test("rejects what could escape the target or exhaust the host", () => {
    for (const bad of [
      zip([{ name: "../evil.txt", data: "x" }]),
      zip([{ name: "/etc/evil.txt", data: "x" }]),
      zip([{ name: "link", data: "/etc/passwd", mode: 0o120777 }]),
      zip([{ name: "big.bin", data: "x".repeat(2000) }]),
      new Uint8Array([1, 2, 3]),
    ])
      expect(() => ZipArchive.read(bad, limits)).toThrow(ZipArchive.InvalidError)
  })
})
