import { describe, expect, test } from "bun:test"
import { mergePreference, savePreference } from "./merge"

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

describe("savePreference", () => {
  // A stand-in server holding one value, which refuses a save whose base is not what it holds.
  const serve = (initial: string | null) => {
    const held = { value: initial, bases: [] as (string | null)[] }
    return {
      held,
      put: async (value: string, base: string | null) => {
        held.bases.push(base)
        if (held.value !== base) return { saved: false, current: held.value }
        held.value = value
        return { saved: true, current: value }
      },
    }
  }

  test("sends the change as is when nothing else moved", async () => {
    const server = serve('{"a":1}')
    const result = await savePreference({ seen: '{"a":1}', server: '{"a":1}', mine: '{"a":2}', attempts: 3, put: server.put })
    expect(result).toEqual({ saved: true, value: '{"a":2}', server: '{"a":2}' })
  })

  test("merges a change another browser saved first", async () => {
    const server = serve('{"a":1,"b":3}')
    const result = await savePreference({ seen: '{"a":1}', server: '{"a":1}', mine: '{"a":2}', attempts: 3, put: server.put })
    expect(JSON.parse(server.held.value!)).toEqual({ a: 2, b: 3 })
    expect(result.saved).toBe(true)
    expect(server.held.bases).toEqual(['{"a":1}', '{"a":1,"b":3}'])
  })

  test("a second edit made before the first was merged keeps both the other browser's change and its own", async () => {
    // The first save met a change from elsewhere (b) and merged it into the server, but the copy on screen is still
    // derived from what was sent, because a newer edit was already waiting.
    const server = serve('{"a":2,"b":3}')
    const result = await savePreference({ seen: '{"a":2}', server: '{"a":2,"b":3}', mine: '{"a":2,"c":4}', attempts: 3, put: server.put })
    expect(JSON.parse(server.held.value!)).toEqual({ a: 2, b: 3, c: 4 })
    expect(result.saved).toBe(true)
  })

  test("gives up after the attempts when the server keeps moving", async () => {
    let count = 0
    const result = await savePreference({
      seen: '{"a":1}',
      server: '{"a":1}',
      mine: '{"a":2}',
      attempts: 3,
      put: async () => ({ saved: false, current: `{"a":1,"n":${++count}}` }),
    })
    expect(result.saved).toBe(false)
    expect(count).toBe(3)
  })
})
