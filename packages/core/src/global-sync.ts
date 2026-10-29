export * as GlobalSync from "./global-sync.js"

import { cp, mkdir, readdir, rm, stat } from "node:fs/promises"
import path from "node:path"
import { GlobalPackage } from "./global-package.js"
import { SharedMcp } from "./shared-mcp.js"

/**
 * Everything `GlobalPackage` and `SharedMcp` keep that every layer must agree on: the packages that carry the install
 * marker (packages placed by hand are not managed and stay where they are), which organizations each is open to, and
 * the shared MCP servers. Per-organization switches are not part of it; they live on the organization's own layer.
 */
const FILES = ["scope.json", "mcp.json"]

/** The managed state as a gzip tar, for a layer that is behind to copy. */
export async function snapshot(config: string, data: string) {
  const files: Record<string, Uint8Array | string> = { "manifest.json": JSON.stringify({ version: 1 }) }
  for (const folder of Object.values(GlobalPackage.FOLDERS)) {
    const root = path.join(config, folder)
    for (const name of await readdir(root).catch(() => [] as string[])) {
      if (!(await GlobalPackage.marker(path.join(root, name)))) continue
      const directory = path.join(root, name)
      for await (const relative of new Bun.Glob("**/*").scan({ cwd: directory, dot: true, onlyFiles: true }))
        files[`config/${folder}/${name}/${relative}`] = await Bun.file(path.join(directory, relative)).bytes()
    }
  }
  for (const name of FILES) {
    const file = Bun.file(path.join(SharedMcp.stateDirectory(data), name))
    if (await file.exists()) files[`data/${name}`] = await file.bytes()
  }
  return new Bun.Archive(files, { compress: "gzip" }).bytes()
}

/** Makes this layer's managed state the one in the snapshot: packages not in it are removed, the rest replaced. */
export async function restore(config: string, data: string, archive: Uint8Array) {
  const directory = SharedMcp.stateDirectory(data)
  const staging = path.join(directory, `.sync-${process.pid}-${Date.now()}`)
  await rm(staging, { recursive: true, force: true })
  await mkdir(staging, { recursive: true })
  try {
    await new Bun.Archive(archive).extract(staging)
    for (const folder of Object.values(GlobalPackage.FOLDERS)) {
      const root = path.join(config, folder)
      await mkdir(root, { recursive: true })
      const incoming = (await readdir(path.join(staging, "config", folder)).catch(() => [] as string[])).filter((name) =>
        GlobalPackage.NAME.test(name),
      )
      for (const name of await readdir(root)) {
        if (!incoming.includes(name) && (await GlobalPackage.marker(path.join(root, name))))
          await rm(path.join(root, name), { recursive: true, force: true })
      }
      for (const name of incoming) {
        const target = path.join(root, name)
        // A hand-placed directory of the same name is not ours to replace.
        if ((await stat(target).then(() => true, () => false)) && !(await GlobalPackage.marker(target))) continue
        await rm(target, { recursive: true, force: true })
        await cp(path.join(staging, "config", folder, name), target, { recursive: true })
      }
    }
    for (const name of FILES) {
      const source = Bun.file(path.join(staging, "data", name))
      if (await source.exists()) await GlobalPackage.writeAtomic(path.join(directory, name), await source.text())
      else await rm(path.join(directory, name), { force: true })
    }
  } finally {
    await rm(staging, { recursive: true, force: true })
  }
}
