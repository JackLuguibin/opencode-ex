import { createEffect, type Accessor } from "solid-js"
import type { ServerConnectionStatus } from "../client"

export function createConnectionSync(input: {
  status: Accessor<ServerConnectionStatus>
  invalidate: () => void
  connected: (info: { reconnect: boolean; resumed: boolean }) => void
}) {
  createEffect(() => {
    if (input.status() === "connected") return
    input.invalidate()
  })

  let connectedOnce = false

  function handleEvent(event: { type: string; data?: { resumed?: boolean } }) {
    if (event.type !== "server.connected") return
    input.connected({ reconnect: connectedOnce, resumed: event.data?.resumed === true })
    connectedOnce = true
  }

  return { handleEvent }
}

// Directories a mounted view holds refresh first; the rest keep their existing order behind them.
export function reconnectOrder(directories: string[], held: (directory: string) => boolean) {
  return [...directories.filter(held), ...directories.filter((directory) => !held(directory))]
}
