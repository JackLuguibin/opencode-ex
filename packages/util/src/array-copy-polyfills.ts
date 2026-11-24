if (!Array.prototype.toSorted) {
  Object.defineProperty(Array.prototype, "toSorted", {
    configurable: true,
    writable: true,
    value: function toSorted<T>(this: T[], compare?: (a: T, b: T) => number) {
      return Array.from(this).sort(compare)
    },
  })
}

if (!Array.prototype.toReversed) {
  Object.defineProperty(Array.prototype, "toReversed", {
    configurable: true,
    writable: true,
    value: function toReversed<T>(this: T[]) {
      return Array.from(this).reverse()
    },
  })
}
