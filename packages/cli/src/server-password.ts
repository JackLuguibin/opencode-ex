// The Vite dev app sends this same password. Loopback `serve` uses it when no
// password is configured, so the web UI connects without the sign-in screen.
export const localDevPassword = "opencode-ex-dev"

export function isLoopbackHost(hostname: string) {
  return (
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname.startsWith("127.") ||
    hostname === "::1" ||
    hostname === "[::1]"
  )
}

export function serverPassword(input: {
  mode: "default" | "service" | "stdio"
  hostname: string
  configured?: string
  servicePassword?: string
  random: string
}) {
  if (input.mode === "service") return input.servicePassword || input.random
  if (input.configured) return input.configured
  if (input.mode === "default" && isLoopbackHost(input.hostname)) return localDevPassword
  return input.random
}
