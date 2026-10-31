import { describe, expect, test } from "bun:test"
import { mergePreference } from "./merge"

const merge = (base: unknown, mine: unknown, theirs: unknown) =>
  JSON.parse(mergePreference(JSON.stringify(base), JSON.stringify(mine), JSON.stringify(theirs)))

describe("mergePreference", () => {
  test("keeps what each side changed in different fields", () => {
    expect(merge({ a: 1, b: 1 }, { a: 2, b: 1 }, { a: 1, b: 3 })).toEqual({ a: 2, b: 3 })
  })

  test("merges nested records, such as one entry per session", () => {
    const base = { permissions: { autoApprove: true, autoApproveSessions: { s1: true } } }
    const mine = { permissions: { autoApprove: true, autoApproveSessions: { s1: true, s2: false } } }
    const theirs = { permissions: { autoApprove: true, autoApproveSessions: { s1: true, s3: true } } }
    expect(merge(base, mine, theirs)).toEqual({
      permissions: { autoApprove: true, autoApproveSessions: { s1: true, s2: false, s3: true } },
    })
  })

  test("a field both sides changed takes this client's value", () => {
    expect(merge({ a: 1 }, { a: 2 }, { a: 3 })).toEqual({ a: 2 })
  })

  test("a deletion is kept unless the other side changed the field", () => {
    expect(merge({ a: 1, b: 1 }, { b: 1 }, { a: 1, b: 2 })).toEqual({ b: 2 })
    expect(merge({ a: 1 }, {}, { a: 2 })).toEqual({})
  })

  test("a field the other side deleted stays deleted when this side left it alone", () => {
    expect(merge({ a: 1, b: 1 }, { a: 2, b: 1 }, { a: 1 })).toEqual({ a: 2 })
  })

  test("arrays are taken whole from whoever changed them", () => {
    expect(merge({ list: [1] }, { list: [1, 2] }, { list: [1], other: 1 })).toEqual({ list: [1, 2], other: 1 })
    expect(merge({ list: [1] }, { list: [1, 2] }, { list: [9] })).toEqual({ list: [1, 2] })
  })

  test("without a stored value, or with values that are not JSON, this client's value stands", () => {
    expect(mergePreference(null, '{"a":1}', null)).toBe('{"a":1}')
    expect(mergePreference('"x"', "not json", '"y"')).toBe("not json")
    expect(mergePreference(null, '{"a":1}', '{"b":2}')).toBe('{"a":1,"b":2}')
  })
})
