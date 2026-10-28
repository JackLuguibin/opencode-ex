import type { LocalProject } from "@/shell/state/layout"

/**
 * Pinned projects come first. Within each group, projects the user has dragged keep their dragged order, and the
 * rest, new ones included, follow creation time with the newest first.
 */
export function orderProjects(projects: readonly LocalProject[], pinned: readonly string[], order: readonly string[]) {
  const rank = new Map(order.map((worktree, index) => [worktree, index]))
  const sorted = projects.toSorted((a, b) => {
    const left = rank.get(a.worktree)
    const right = rank.get(b.worktree)

    if (left !== undefined && right !== undefined) return left - right
    if (left !== undefined) return 1
    if (right !== undefined) return -1

    return (b.time?.created ?? 0) - (a.time?.created ?? 0)
  })
  const pins = new Set(pinned)

  return [...sorted.filter((project) => pins.has(project.worktree)), ...sorted.filter((project) => !pins.has(project.worktree))]
}
