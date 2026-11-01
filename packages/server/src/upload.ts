import fs from "fs/promises"
import path from "path"

/**
 * Resumable uploads keep their state on disk next to the data, so they survive a restart and need no database. Under
 * `<base>/.opencode/upload/`, an upload is a metadata file, a sparse file of the final size that chunks are written
 * into at their offsets, and a folder holding one empty marker per chunk that has fully arrived. Markers are created
 * after the chunk's bytes, and chunks in flight at the same time never write to the same marker.
 */

const MiB = 1024 * 1024

export const DEFAULT_MAX_BYTES = 64 * 1024 * MiB
export const MAX_ACTIVE_PER_USER = 8
const IDLE_MS = 24 * 60 * 60 * 1000

export interface Meta {
  readonly id: string
  /** The member who started it, or null for the operator. */
  readonly owner: string | null
  readonly target: string
  readonly size: number
  readonly chunkSize: number
  readonly onConflict: "fail" | "replace" | "rename"
}

/** Chunks stay small so no request body is large; huge files get bigger chunks to keep the count under 4096. */
export const chunkSizeFor = (size: number) => (size > 32 * 1024 * MiB ? 32 * MiB : 8 * MiB)

export const chunkCount = (meta: Pick<Meta, "size" | "chunkSize">) => Math.ceil(meta.size / meta.chunkSize)

export const chunkLength = (meta: Pick<Meta, "size" | "chunkSize">, index: number) =>
  Math.min(meta.chunkSize, meta.size - index * meta.chunkSize)

export const isUploadID = (id: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id)

const dirOf = (base: string) => path.join(base, ".opencode", "upload")
const metaOf = (base: string, id: string) => path.join(dirOf(base), `${id}.json`)
const partOf = (base: string, id: string) => path.join(dirOf(base), `${id}.part`)
const chunksOf = (base: string, id: string) => path.join(dirOf(base), `${id}.chunks`)

export async function read(base: string, id: string): Promise<Meta | undefined> {
  return Bun.file(metaOf(base, id))
    .json()
    .catch(() => undefined)
}

/** The numbers of the chunks that have fully arrived, in order. */
export async function received(base: string, id: string) {
  const names = await fs.readdir(chunksOf(base, id)).catch(() => [] as string[])
  return names.map(Number).filter(Number.isInteger).sort((a, b) => a - b)
}

export async function create(base: string, meta: Meta) {
  await fs.mkdir(chunksOf(base, meta.id), { recursive: true })
  await Bun.write(metaOf(base, meta.id), JSON.stringify(meta))
  // Sparse: the file has its final size from the start but takes no disk until chunks land.
  const handle = await fs.open(partOf(base, meta.id), "w")
  await handle.truncate(meta.size).finally(() => handle.close())
}

/** The sparse file chunks are written into, opened for writing at any offset. */
export const openPart = (base: string, id: string) => fs.open(partOf(base, id), "r+")

/** Records that a chunk is whole. Called only after its last byte is written. */
export const mark = (base: string, id: string, index: number) => Bun.write(path.join(chunksOf(base, id), String(index)), "")

export async function discard(base: string, id: string) {
  await Promise.all([
    fs.rm(metaOf(base, id), { force: true }),
    fs.rm(partOf(base, id), { force: true }),
    fs.rm(chunksOf(base, id), { force: true, recursive: true }),
  ])
}

async function all(base: string) {
  const names = await fs.readdir(dirOf(base)).catch(() => [] as string[])
  const metas = await Promise.all(
    names.filter((name) => name.endsWith(".json")).map((name) => read(base, name.slice(0, -".json".length))),
  )
  return metas.filter((meta): meta is Meta => meta !== undefined)
}

/** Drops uploads nobody has sent a chunk to for a day, then reports what the rest still need, for space accounting. */
export async function sweep(base: string) {
  const metas = await all(base)
  const live = await Promise.all(
    metas.map(async (meta) => {
      const times = await Promise.all(
        [metaOf(base, meta.id), chunksOf(base, meta.id)].map((file) =>
          fs.stat(file).then(
            (stat) => stat.mtimeMs,
            () => 0,
          ),
        ),
      )
      if (Date.now() - Math.max(...times) <= IDLE_MS) return meta
      await discard(base, meta.id)
    }),
  )
  const kept = live.filter((meta): meta is Meta => meta !== undefined)
  const missing = await Promise.all(
    kept.map(async (meta) => Math.max(meta.size - (await received(base, meta.id)).length * meta.chunkSize, 0)),
  )
  return { active: kept, reserved: missing.reduce((sum, bytes) => sum + bytes, 0) }
}

/** Bytes available on the volume that holds `directory`, or Infinity where the platform cannot say. */
export async function available(directory: string) {
  const stat = await fs.statfs(await nearestExisting(directory)).catch(() => undefined)
  return stat ? stat.bavail * stat.bsize : Infinity
}

async function nearestExisting(target: string): Promise<string> {
  const found = await fs.stat(target).then(
    () => true,
    () => false,
  )
  if (found || path.dirname(target) === target) return target
  return nearestExisting(path.dirname(target))
}

/** Whether the target, following any symbolic links on the way, leaves `root`. */
export async function leaves(target: string, root: string) {
  const [real, base] = await Promise.all([fs.realpath(await nearestExisting(target)), fs.realpath(root)])
  const relative = path.relative(base, real)
  return relative.startsWith("..") || path.isAbsolute(relative)
}

export async function exists(target: string) {
  return fs.lstat(target).then(
    () => true,
    () => false,
  )
}

/** `report.pdf` becomes `report (1).pdf`, then `report (2).pdf`, until the name is free. */
export async function freeName(target: string, attempt = 1): Promise<string> {
  const extension = path.extname(target)
  const candidate = `${target.slice(0, target.length - extension.length)} (${attempt})${extension}`
  return (await exists(candidate)) ? freeName(target, attempt + 1) : candidate
}

/** Moves the finished file into place in one step; across volumes it is copied beside the target first. */
export async function place(base: string, meta: Meta, target: string) {
  await fs.mkdir(path.dirname(target), { recursive: true })
  const part = partOf(base, meta.id)
  await fs.rename(part, target).catch(async (error: NodeJS.ErrnoException) => {
    if (error.code !== "EXDEV") throw error
    const staged = `${target}.${meta.id}.part`
    await fs.copyFile(part, staged)
    await fs.rename(staged, target)
  })
  await discard(base, meta.id)
}
