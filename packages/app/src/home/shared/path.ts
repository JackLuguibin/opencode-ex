import { pathKey } from "@/workspaces/path-key"

/** Folder name of an organization's shared space inside its directory. */
const SHARED_DIRECTORY = "公共空间"

/** The shared space of the organization whose directory is `root`, or undefined without an organization. */
export function sharedDirectory(root: string | undefined) {
  return root ? `${root.replace(/[\\/]+$/, "")}/${SHARED_DIRECTORY}` : undefined
}

export function isSharedDirectory(root: string | undefined, directory: string) {
  const shared = sharedDirectory(root)

  return !!shared && pathKey(directory) === pathKey(shared)
}
