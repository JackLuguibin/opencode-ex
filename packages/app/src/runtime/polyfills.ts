import "@opencode/util/array-copy-polyfills"

// The web app also runs on browsers such as Chrome 109 that lack some newer runtime APIs.
if (!crypto.randomUUID) {
  crypto.randomUUID = function randomUUID() {
    const bytes = crypto.getRandomValues(new Uint8Array(16))
    bytes[6] = (bytes[6] & 0x0f) | 0x40
    bytes[8] = (bytes[8] & 0x3f) | 0x80
    const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
  }
}

if (!AbortSignal.any) {
  AbortSignal.any = function any(signals: AbortSignal[]) {
    const controller = new AbortController()
    const aborted = signals.find((signal) => signal.aborted)
    if (aborted) {
      controller.abort(aborted.reason)
      return controller.signal
    }

    for (const signal of signals) {
      signal.addEventListener("abort", () => controller.abort(signal.reason), { signal: controller.signal })
    }
    return controller.signal
  }
}

if (!URL.canParse) {
  URL.canParse = function canParse(url, base) {
    try {
      new URL(url, base)
      return true
    } catch {
      return false
    }
  }
}

if (!("size" in URLSearchParams.prototype)) {
  Object.defineProperty(URLSearchParams.prototype, "size", {
    configurable: true,
    get(this: URLSearchParams) {
      return Array.from(this).length
    },
  })
}

if (!Map.groupBy) {
  Map.groupBy = function groupBy<K, T>(items: Iterable<T>, callback: (item: T, index: number) => K) {
    const groups = new Map<K, T[]>()
    let index = 0

    for (const item of items) {
      const key = callback(item, index++)
      const group = groups.get(key)

      if (group) group.push(item)
      else groups.set(key, [item])
    }

    return groups
  }
}

if (!Promise.withResolvers) {
  Promise.withResolvers = function withResolvers<T>() {
    let resolve!: (value: T | PromiseLike<T>) => void
    let reject!: (reason?: Error) => void

    const promise = new Promise<T>((res, rej) => {
      resolve = res
      reject = rej
    })

    return { promise, resolve, reject }
  }
}

if (!Promise.try) {
  // SAFETY: the callback's return type is carried through unchanged, which is all Promise.try promises.
  Promise.try = function tryCall<T, U extends unknown[]>(callback: (...args: U) => T | PromiseLike<T>, ...args: U) {
    return new Promise<T>((resolve) => resolve(callback(...args)))
  } as typeof Promise.try
}
