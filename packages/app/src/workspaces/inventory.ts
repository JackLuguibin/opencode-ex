import type { QueryClient } from "@tanstack/solid-query"
import type { WorktreeDirectory } from "@opencode/client/promise"
import type { ServerApi } from "@/runtime/server/api"
import type { ServerScope } from "@/runtime/server/scope"
import type { Project } from "@/runtime/server/types"
import { sameDirectory } from "@opencode/util/path"

export function worktreeInventoryKey(scope: ServerScope, projectID: string) {
  return [scope, "worktree", projectID] as const
}

export function worktreeInventoryViewKey(scope: ServerScope, projectID?: string) {
  return [scope, "settings-workspace-inventory", projectID ?? null] as const
}

// Project metadata arrives without worktrees; a loaded inventory supplies the workspace list.
export function withWorktreeInventory(project: Project, worktrees: readonly WorktreeDirectory[] | undefined): Project {
  if (!worktrees) return project

  return {
    ...project,
    worktrees: [...worktrees],
    sandboxes: worktrees
      .map((item) => item.directory)
      .filter((directory) => !sameDirectory(project.worktree, directory)),
  }
}

// Reads use saved inventory; explicit demand also discovers external worktree changes.
export function createWorktreeInventory(input: {
  scope: ServerScope
  queryClient: QueryClient
  api: () => Pick<ServerApi["worktree"], "list" | "refresh">
  updated: (projectID: string, worktrees: WorktreeDirectory[]) => void
}) {
  const options = (projectID: string) => ({
    queryKey: worktreeInventoryKey(input.scope, projectID),
    queryFn: () =>
      input
        .api()
        .list({ projectID })
        .then((items) => {
          input.updated(projectID, items)

          return items
        }),
    // `worktree.updated` and reconnect invalidation drive list reloads; time alone does not re-list.
    staleTime: Infinity,
    gcTime: Infinity,
    retry: false,
  })

  // Every view showing a project asks for a scan, and the server walks the repository for each; asks that arrive while
  // one is running share it.
  const scanning = new Map<string, Promise<void>>()

  return {
    cached: (projectID: string) =>
      input.queryClient.getQueryData<WorktreeDirectory[]>(worktreeInventoryKey(input.scope, projectID)),
    list: (projectID: string) =>
      input.queryClient.fetchQuery({ ...options(projectID), staleTime: 0 }).catch(() => undefined),
    refresh: (projectID: string) => {
      const pending = scanning.get(projectID)
      if (pending) return pending
      const scan = input
        .api()
        .refresh({ projectID })
        .then(() => undefined, () => undefined)
        .finally(() => scanning.delete(projectID))
      scanning.set(projectID, scan)
      return scan
    },
  }
}
