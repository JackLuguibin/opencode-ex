import { afterEach, describe, expect, test } from "bun:test"
import { RedisConnection } from "../src/redis-connection.js"

const url = process.env.OPENCODE_TEST_REDIS_URL

// Stands between the client and Redis so a test can cut the connection and bring it back on the same port.
function relay(target: URL, port = 0) {
  const sockets = new Set<{ end(): void }>()
  const server = Bun.listen<{ upstream?: Awaited<ReturnType<typeof Bun.connect>>; queue: Uint8Array[] }>({
    hostname: "127.0.0.1",
    port,
    socket: {
      open(client) {
        client.data = { queue: [] }
        sockets.add(client)
        void Bun.connect({
          hostname: target.hostname,
          port: Number(target.port || 6379),
          socket: {
            open(upstream) {
              sockets.add(upstream)
              client.data.upstream = upstream
              client.data.queue.forEach((chunk) => upstream.write(chunk))
            },
            data: (_, chunk) => void client.write(chunk),
            close: () => void client.end(),
          },
        })
      },
      data(client, chunk) {
        if (client.data.upstream) client.data.upstream.write(chunk)
        else client.data.queue.push(chunk)
      },
      close(client) {
        client.data.upstream?.end()
      },
    },
  })
  return {
    port: server.port,
    cut: () => {
      server.stop(true)
      sockets.forEach((socket) => socket.end())
    },
  }
}

// These need a Redis (OPENCODE_TEST_REDIS_URL); `bun run test:stack` provides one.
describe.skipIf(!url)("redis connection", () => {
  const clients: ReturnType<typeof RedisConnection.connect>[] = []
  afterEach(() => clients.splice(0).forEach((client) => client.close()))

  const set = (client: ReturnType<typeof RedisConnection.connect>) => client.set("redis-connection-probe", "1").then(() => true, () => false)

  test("works again after the server was unreachable for longer than a few retries", async () => {
    const first = relay(new URL(url!))
    const client = RedisConnection.connect(`redis://127.0.0.1:${first.port}`)
    clients.push(client)
    expect(await set(client)).toBe(true)
    first.cut()
    // Long enough for several failed attempts, which Bun's default client counts toward giving up.
    await Bun.sleep(8_000)
    const second = relay(new URL(url!), first.port)
    await Bun.sleep(3_000)
    expect(await set(client)).toBe(true)
    second.cut()
  }, 30_000)

  test("does not reconnect after close", async () => {
    const proxy = relay(new URL(url!))
    const client = RedisConnection.connect(`redis://127.0.0.1:${proxy.port}`)
    expect(await set(client)).toBe(true)
    client.close()
    await Bun.sleep(2_500)
    expect(client.connected).toBe(false)
    proxy.cut()
  }, 15_000)
})
