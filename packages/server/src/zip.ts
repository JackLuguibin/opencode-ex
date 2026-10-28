import { deflateRawSync } from "node:zlib"

export interface ZipEntry {
  readonly name: string
  /** Omitted for a directory entry. Directory names end with `/`. */
  readonly bytes?: Uint8Array
}

const crcTable = Uint32Array.from({ length: 256 }, (_, index) => {
  let value = index
  for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
  return value
})

/** One zip archive. Names stay inside the archive: no absolute paths and no `..` segments. */
export function zip(entries: readonly ZipEntry[], date = new Date()): Uint8Array {
  const stamp = dosDate(date)
  const locals: Uint8Array[] = []
  const central: Uint8Array[] = []
  let offset = 0
  for (const entry of entries) {
    const name = zipName(entry.name)
    const directory = name.endsWith("/")
    const raw = directory ? new Uint8Array() : (entry.bytes ?? new Uint8Array())
    const stored = directory ? raw : deflateRawSync(raw)
    const compressed = !directory && stored.byteLength < raw.byteLength ? stored : raw
    const method = compressed === raw ? 0 : 8
    const encoded = new TextEncoder().encode(name)
    if (encoded.byteLength > 0xffff || raw.byteLength > 0xffffffff || compressed.byteLength > 0xffffffff) {
      throw new Error(`Archive entry is too large: ${name}`)
    }
    const local = fileHeader(0x04034b50, encoded, method, stamp, crc32(raw), compressed.byteLength, raw.byteLength)
    const record = fileHeader(
      0x02014b50,
      encoded,
      method,
      stamp,
      crc32(raw),
      compressed.byteLength,
      raw.byteLength,
      offset,
    )
    locals.push(local, encoded, compressed)
    central.push(record, encoded)
    offset += local.byteLength + encoded.byteLength + compressed.byteLength
  }
  const centralOffset = offset
  const centralSize = central.reduce((sum, part) => sum + part.byteLength, 0)
  if (entries.length > 0xffff || centralSize > 0xffffffff || centralOffset > 0xffffffff) {
    throw new Error("Archive is too large")
  }
  return concat([...locals, ...central, endHeader(entries.length, centralSize, centralOffset)])
}

function zipName(name: string) {
  const normalized = name.replaceAll("\\", "/")
  if (!normalized || normalized.startsWith("/") || normalized.split("/").includes("..")) {
    throw new Error(`Unsafe archive path: ${name}`)
  }
  return normalized
}

function dosDate(date: Date) {
  const year = Math.max(date.getFullYear(), 1980)
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1),
    day: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  }
}

function crc32(bytes: Uint8Array) {
  let value = 0xffffffff
  for (const byte of bytes) value = crcTable[(value ^ byte) & 0xff]! ^ (value >>> 8)
  return (value ^ 0xffffffff) >>> 0
}

function fileHeader(
  signature: number,
  name: Uint8Array,
  method: number,
  stamp: { time: number; day: number },
  crc: number,
  compressed: number,
  uncompressed: number,
  offset?: number,
) {
  const central = offset !== undefined
  const header = new Uint8Array(central ? 46 : 30)
  const view = new DataView(header.buffer)
  view.setUint32(0, signature, true)
  if (central) view.setUint16(4, 0x0314, true)
  view.setUint16(central ? 6 : 4, 20, true)
  view.setUint16(central ? 8 : 6, 0x800, true)
  view.setUint16(central ? 10 : 8, method, true)
  view.setUint16(central ? 12 : 10, stamp.time, true)
  view.setUint16(central ? 14 : 12, stamp.day, true)
  view.setUint32(central ? 16 : 14, crc, true)
  view.setUint32(central ? 20 : 18, compressed, true)
  view.setUint32(central ? 24 : 22, uncompressed, true)
  view.setUint16(central ? 28 : 26, name.byteLength, true)
  if (central) {
    view.setUint32(38, (name[name.byteLength - 1] === 0x2f ? 0o040755 : 0o100644) << 16, true)
    view.setUint32(42, offset, true)
  }
  return header
}

function endHeader(count: number, size: number, offset: number) {
  const header = new Uint8Array(22)
  const view = new DataView(header.buffer)
  view.setUint32(0, 0x06054b50, true)
  view.setUint16(8, count, true)
  view.setUint16(10, count, true)
  view.setUint32(12, size, true)
  view.setUint32(16, offset, true)
  return header
}

function concat(parts: readonly Uint8Array[]) {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.byteLength, 0))
  let at = 0
  for (const part of parts) {
    out.set(part, at)
    at += part.byteLength
  }
  return out
}
