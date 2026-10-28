export type PickNode = {
  path: string
  type: "file" | "directory"
  checked: boolean
  /** Children have been listed. An unlisted checked directory stands for everything inside it. */
  listed: boolean
  children: readonly string[]
}

export type SelectionMark = "on" | "off" | "mixed"

/** `undefined` means the whole directory. An empty list means nothing is selected. */
export function chosenPaths(
  nodes: Readonly<Record<string, PickNode>>,
  roots: readonly string[],
): readonly string[] | undefined {
  if (roots.length === 0) return []

  if (roots.every((path) => selectionMark(nodes, path) === "on")) return undefined

  return roots.flatMap((path) => includedPaths(nodes, path))
}

export function selectionMark(nodes: Readonly<Record<string, PickNode>>, path: string): SelectionMark {
  const node = nodes[path]

  if (!node) return "off"

  if (node.type === "file" || !node.listed || node.children.length === 0) return node.checked ? "on" : "off"

  const marks = node.children.map((child) => selectionMark(nodes, child))

  if (marks.every((mark) => mark === "on")) return "on"

  if (marks.every((mark) => mark === "off")) return "off"

  return "mixed"
}

function includedPaths(nodes: Readonly<Record<string, PickNode>>, path: string): readonly string[] {
  const node = nodes[path]
  const mark = selectionMark(nodes, path)

  if (!node || mark === "off") return []

  if (mark === "on") return [node.path]

  return node.children.flatMap((child) => includedPaths(nodes, child))
}
