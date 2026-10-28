export * as ZipArchive from "./zip-archive.js"

import { inflateRawSync } from "node:zlib"

export interface Limits {
  readonly files: number
  /** Total size of all extracted files. */
  readonly bytes: number
}

export class InvalidError extends Error {
  readonly _tag = "ZipArchive.InvalidError"
}

export interface Entry {
  /** Normalized relative path using `/`. */
  readonly path: string
  readonly data: Uint8Array
}

const END_OF_CENTRAL_DIRECTORY = 0x06054b50
const CENTRAL_DIRECTORY_HEADER = 0x02014b50
const LOCAL_HEADER = 0x04034b50

/**
 * Reads the regular files of an untrusted zip. Entries that could write outside the target (absolute or `..` paths),
 * symlinks, and archives that expand beyond the limits are rejected rather than skipped, so a package is never
 * installed half-extracted.
 */
export function read(input: Uint8Array, limits: Limits): Entry[] {
  const view = new DataView(input.buffer, input.byteOffset, input.byteLength)
  const end = findEnd(view)
  const count = view.getUint16(end + 10, true)
  let offset = view.getUint32(end + 16, true)
  if (count > limits.files) throw new InvalidError("Archive has too many files")
  const entries: Entry[] = []
  let total = 0
  for (let index = 0; index < count; index++) {
    if (offset + 46 > input.length || view.getUint32(offset, true) !== CENTRAL_DIRECTORY_HEADER)
      throw new InvalidError("Archive is corrupt")
    const flags = view.getUint16(offset + 8, true)
    const method = view.getUint16(offset + 10, true)
    const compressed = view.getUint32(offset + 20, true)
    const size = view.getUint32(offset + 24, true)
    const nameLength = view.getUint16(offset + 28, true)
    const extraLength = view.getUint16(offset + 30, true)
    const commentLength = view.getUint16(offset + 32, true)
    const attributes = view.getUint32(offset + 38, true)
    const local = view.getUint32(offset + 42, true)
    const name = new TextDecoder().decode(input.subarray(offset + 46, offset + 46 + nameLength))
    offset += 46 + nameLength + extraLength + commentLength
    if (flags & 1) throw new InvalidError("Encrypted archives are not supported")
    const directory = name.endsWith("/")
    // The high half of the external attributes holds the Unix mode; 0o120000 marks a symlink.
    if (((attributes >>> 16) & 0o170000) === 0o120000) throw new InvalidError(`Archive contains a symlink: ${name}`)
    const clean = normalize(name)
    if (directory) continue
    total += size
    if (total > limits.bytes) throw new InvalidError("Archive is too large once extracted")
    if (local + 30 > input.length || view.getUint32(local, true) !== LOCAL_HEADER) throw new InvalidError("Archive is corrupt")
    const start = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true)
    const packed = input.subarray(start, start + compressed)
    if (packed.length !== compressed) throw new InvalidError("Archive is corrupt")
    const data = unpack(method, packed, size)
    if (data.length !== size) throw new InvalidError("Archive is corrupt")
    entries.push({ path: clean, data })
  }
  return entries
}

function findEnd(view: DataView) {
  // The end record is at the very end unless a comment follows it.
  const floor = Math.max(0, view.byteLength - 22 - 0xffff)
  for (let at = view.byteLength - 22; at >= floor; at--) {
    if (view.getUint32(at, true) === END_OF_CENTRAL_DIRECTORY) return at
  }
  throw new InvalidError("Not a zip archive")
}

function unpack(method: number, packed: Uint8Array, size: number) {
  if (method === 0) return packed
  if (method !== 8) throw new InvalidError("Unsupported compression method")
  try {
    return inflateRawSync(packed, { maxOutputLength: size })
  } catch {
    throw new InvalidError("Archive is corrupt or larger than it declares")
  }
}

function normalize(name: string) {
  const value = name.replaceAll("\\", "/")
  const parts = value.split("/").filter((part) => part !== "" && part !== ".")
  if (value.startsWith("/") || /^[A-Za-z]:/.test(value) || parts.some((part) => part === ".."))
    throw new InvalidError(`Unsafe path in archive: ${name}`)
  if (parts.length === 0) throw new InvalidError("Archive contains an empty path")
  return parts.join("/")
}
