import { describe, expect, test, vi } from "bun:test"
import type { ShellOutputInput, ShellOutputOutput } from "@opencode/client/promise"
import { followShellOutput, SHELL_OUTPUT_TAIL_BYTES } from "./shell-output"

const location = { directory: "/repo", project: { id: "project", directory: "/repo", canonical: "/repo" } }

// Serves the current text from the requested cursor, at most one page per request.
function server(text: () => string, page = Infinity) {
  const cursors: number[] = []

  return {
    cursors,
    load: (input: ShellOutputInput): Promise<ShellOutputOutput> => {
      const cursor = input.cursor ?? 0
      cursors.push(cursor)
      const full = text()
      const output = full.slice(cursor, cursor + page)

      return Promise.resolve({
        location,
        data: { output, cursor: cursor + output.length, size: full.length, truncated: false },
      })
    },
  }
}

// Reads settle within a few microtasks; timers are faked so this never waits on the clock.
async function flush() {
  for (let i = 0; i < 20; i++) await Promise.resolve()
}

describe("followShellOutput", () => {
  test("stops polling a missing shell and never requests it again", async () => {
    vi.useFakeTimers()

    try {
      const cursors: number[] = []

      const load = (input: ShellOutputInput): Promise<ShellOutputOutput> => {
        cursors.push(input.cursor ?? 0)

        return Promise.reject({ _tag: "ShellNotFoundError", id: input.id, message: "Shell command not found" })
      }

      const follow = () =>
        followShellOutput({ id: "shell_missing", directory: "/repo", running: true, load, onOutput() {} })

      const stop = follow()
      await flush()
      expect(cursors).toEqual([0])

      vi.advanceTimersByTime(10_000)
      await flush()
      expect(cursors).toEqual([0])

      stop()
      const remounted = follow()
      await flush()
      vi.advanceTimersByTime(10_000)
      remounted()
      expect(cursors).toEqual([0])
    } finally {
      vi.useRealTimers()
    }
  })

  test("polls a running shell once per second and resumes from the cached cursor after a remount", async () => {
    vi.useFakeTimers()

    try {
      let text = "hello\n"
      const shell = server(() => text)
      const outputs: string[] = []

      const follow = (running: boolean) =>
        followShellOutput({
          id: "shell_live",
          directory: "/repo",
          running,
          load: shell.load,
          onOutput: (output) => outputs.push(output),
        })

      const first = follow(true)
      await flush()
      expect(outputs.at(-1)).toBe("hello\n")

      text += "world\n"
      vi.advanceTimersByTime(1_000)
      await flush()
      expect(shell.cursors).toEqual([0, 6])
      expect(outputs.at(-1)).toBe("hello\nworld\n")

      first()
      text += "done\n"
      const second = follow(true)
      await flush()
      expect(shell.cursors).toEqual([0, 6, 12])
      expect(outputs.at(-1)).toBe("hello\nworld\ndone\n")

      second()
      const exited = follow(false)
      await flush()
      exited()
      expect(shell.cursors).toEqual([0, 6, 12, 17])

      outputs.length = 0
      follow(false)()
      await flush()
      expect(shell.cursors).toEqual([0, 6, 12, 17])
      expect(outputs).toEqual(["hello\nworld\ndone\n"])

      // The running-shell inventory can arrive late; a complete shell believed to be live is re-read from its cursor.
      follow(true)()
      expect(shell.cursors).toEqual([0, 6, 12, 17, 17])
    } finally {
      vi.useRealTimers()
    }
  })

  test("keeps only the most recent tail of a large output", async () => {
    const shell = server(() => "a".repeat(SHELL_OUTPUT_TAIL_BYTES) + "tail", SHELL_OUTPUT_TAIL_BYTES)
    const outputs: string[] = []
    followShellOutput({
      id: "shell_large",
      directory: "/repo",
      running: false,
      load: shell.load,
      onOutput: (output) => outputs.push(output),
    })
    await flush()
    expect(shell.cursors).toEqual([0, SHELL_OUTPUT_TAIL_BYTES])
    expect(outputs.at(-1)?.length).toBe(SHELL_OUTPUT_TAIL_BYTES)
    expect(outputs.at(-1)?.endsWith("a".repeat(8) + "tail")).toBe(true)
  })

  test("reads a running shell when told there is output, never on a timer, and once more for a notice mid-read", async () => {
    vi.useFakeTimers()

    try {
      let text = "a"
      const listeners = new Set<() => void>()
      const source = server(() => text)
      const seen: string[] = []
      const stop = followShellOutput({
        id: "shell_event_driven",
        directory: "/repo",
        running: true,
        load: source.load,
        changed: (_id, listener) => {
          listeners.add(listener)

          return () => listeners.delete(listener)
        },
        onOutput: (output) => seen.push(output),
      })
      await flush()
      expect(seen.at(-1)).toBe("a")

      // Time passing alone reads nothing.
      vi.advanceTimersByTime(30_000)
      await flush()
      expect(source.cursors).toEqual([0])

      text = "ab"
      listeners.forEach((listener) => listener())
      await flush()
      expect(seen.at(-1)).toBe("ab")

      // Two notices before the read settles still end with everything read.
      text = "abcd"
      listeners.forEach((listener) => listener())
      listeners.forEach((listener) => listener())
      await flush()
      expect(seen.at(-1)).toBe("abcd")
      expect(source.cursors.at(-1)).toBe(4)

      stop()
      expect(listeners.size).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })
})
