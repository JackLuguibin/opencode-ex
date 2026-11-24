import type { OpenCodeEventEncoded } from "./groups/event.js"

type Fragment = Extract<
  OpenCodeEventEncoded,
  { type: "session.text.delta" | "session.reasoning.delta" | "session.tool.input.delta" | "session.compaction.delta" }
>
type OpenFragment<E> = { event: E; chunks: string[] }

export function isFragment<E extends { type: string }>(event: E): event is E & Fragment {
  return (
    event.type === "session.text.delta" ||
    event.type === "session.reasoning.delta" ||
    event.type === "session.tool.input.delta" ||
    event.type === "session.compaction.delta"
  )
}

/** Open fragments are independent of the replay log, which can roll over while a response is still streaming. */
export function streamFragments<E extends OpenCodeEventEncoded>() {
  type Delta = E & Fragment
  const sessions = new Map<string, Map<string, OpenFragment<Delta>>>()

  function update(event: E) {
    if (isFragment(event)) {
      const id = event.data.sessionID
      const fragments = sessions.get(id) ?? new Map<string, OpenFragment<Delta>>()
      if (!sessions.has(id)) sessions.set(id, fragments)
      const key = fragmentKey(event)
      const chunk = "text" in event.data ? event.data.text : event.data.delta
      const fragment = fragments.get(key)
      if (fragment && !event.data.replace) fragment.chunks.push(chunk)
      else fragments.set(key, { event, chunks: [chunk] })
      return
    }

    switch (event.type) {
      case "session.deleted":
      case "session.moved":
      case "session.execution.succeeded":
      case "session.execution.failed":
      case "session.execution.interrupted":
      case "session.step.started":
      case "session.step.ended":
      case "session.step.failed":
        sessions.delete(event.data.sessionID)
        return
      case "session.text.ended":
      case "session.reasoning.ended":
      case "session.tool.input.ended":
      case "session.compaction.ended":
      case "session.compaction.failed": {
        const fragments = sessions.get(event.data.sessionID)
        if (!fragments) return
        fragments.delete(fragmentKey(event))
        if (!fragments.size) sessions.delete(event.data.sessionID)
      }
    }
  }

  return {
    update,
    clear: () => sessions.clear(),
    snapshot(sessionID: string) {
      return Array.from(sessions.get(sessionID)?.values() ?? [], ({ event, chunks }): Delta => {
        return replaceFragment(event, chunks.join(""))
      })
    },
  }
}

function replaceFragment<T extends Fragment>(event: T, value: string): T {
  const data = event.data
  return { ...event, data: { ...data, ...("text" in data ? { text: value } : { delta: value }), replace: true } }
}

function fragmentKey(
  event: Extract<
    OpenCodeEventEncoded,
    {
      type:
        | Fragment["type"]
        | "session.text.ended"
        | "session.reasoning.ended"
        | "session.tool.input.ended"
        | "session.compaction.ended"
        | "session.compaction.failed"
    }
  >,
) {
  switch (event.type) {
    case "session.text.delta":
    case "session.text.ended":
      return `text:${event.data.assistantMessageID}:${event.data.ordinal}`
    case "session.reasoning.delta":
    case "session.reasoning.ended":
      return `reasoning:${event.data.assistantMessageID}:${event.data.ordinal}`
    case "session.tool.input.delta":
    case "session.tool.input.ended":
      return `tool:${event.data.assistantMessageID}:${event.data.id}`
    default:
      return "compaction"
  }
}
