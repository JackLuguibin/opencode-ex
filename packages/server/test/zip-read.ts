import { inflateRawSync } from "node:zlib"

export function readZip(data: Uint8Array) {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength)
  const out: { name: string; bytes: Uint8Array }[] = []
  let offset = 0
  const decoder = new TextDecoder()
  while (offset + 30 <= data.byteLength) {
    if (view.getUint32(offset, true) !== 0x04034b50) break
    const method = view.getUint16(offset + 8, true)
    const compressed = view.getUint32(offset + 18, true)
    const nameLength = view.getUint16(offset + 26, true)
    const extraLength = view.getUint16(offset + 28, true)
    const nameStart = offset + 30
    const dataStart = nameStart + nameLength + extraLength
    const payload = data.subarray(dataStart, dataStart + compressed)
    const bytes = method === 0 ? payload : inflateRawSync(payload)
    out.push({ name: decoder.decode(data.subarray(nameStart, nameStart + nameLength)), bytes: Uint8Array.from(bytes) })
    offset = dataStart + compressed
  }
  return out
}
