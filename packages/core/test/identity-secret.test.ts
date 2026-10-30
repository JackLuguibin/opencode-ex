import { describe, expect, test } from "bun:test"
import { IdentitySecret } from "@opencode/core/identity/secret"

const key = (byte: number) => Buffer.alloc(32, byte).toString("base64")

describe("IdentitySecret", () => {
  test("seals a value and opens it with the same key", () => {
    const keys = IdentitySecret.fromEnv({ OPENCODE_SECRET_KEY: key(1) })!
    const sealed = IdentitySecret.seal(keys, "sk-live-secret")
    expect(sealed).not.toContain("sk-live-secret")
    expect(sealed.startsWith(`v1:${IdentitySecret.id(keys.current)}:`)).toBe(true)
    expect(IdentitySecret.open(keys, sealed)).toBe("sk-live-secret")
    // A fresh nonce each time, so equal values don't look equal in the database.
    expect(IdentitySecret.seal(keys, "sk-live-secret")).not.toBe(sealed)
  })

  test("does not open with another key or a changed value", () => {
    const keys = IdentitySecret.fromEnv({ OPENCODE_SECRET_KEY: key(1) })!
    const other = IdentitySecret.fromEnv({ OPENCODE_SECRET_KEY: key(2) })!
    const sealed = IdentitySecret.seal(keys, "sk-live-secret")
    expect(IdentitySecret.open(other, sealed)).toBeUndefined()
    const [version, id, iv, tag, data] = sealed.split(":")
    const flipped = Buffer.from(data!, "base64")
    flipped[0] = flipped[0]! ^ 1
    expect(IdentitySecret.open(keys, [version, id, iv, tag, flipped.toString("base64")].join(":"))).toBeUndefined()
    expect(IdentitySecret.open(keys, "not a sealed value")).toBeUndefined()
  })

  test("opens values sealed by a previous key", () => {
    const old = IdentitySecret.fromEnv({ OPENCODE_SECRET_KEY: key(1) })!
    const sealed = IdentitySecret.seal(old, "sk-live-secret")
    const rotated = IdentitySecret.fromEnv({ OPENCODE_SECRET_KEY: key(2), OPENCODE_SECRET_KEY_PREVIOUS: `${key(3)}, ${key(1)}` })!
    expect(IdentitySecret.open(rotated, sealed)).toBe("sk-live-secret")
    expect(IdentitySecret.sealedWith(sealed)).toBe(IdentitySecret.id(old.current))
    expect(IdentitySecret.sealedWith(IdentitySecret.seal(rotated, "x"))).toBe(IdentitySecret.id(rotated.current))
  })

  test("is off without a valid 32 byte key", () => {
    expect(IdentitySecret.fromEnv({})).toBeUndefined()
    expect(IdentitySecret.fromEnv({ OPENCODE_SECRET_KEY: "" })).toBeUndefined()
    expect(IdentitySecret.fromEnv({ OPENCODE_SECRET_KEY: Buffer.alloc(16).toString("base64") })).toBeUndefined()
    // A bad previous key is ignored rather than turning the feature off.
    expect(IdentitySecret.fromEnv({ OPENCODE_SECRET_KEY: key(1), OPENCODE_SECRET_KEY_PREVIOUS: "bad" })?.previous).toEqual([])
  })
})
