import { expect, test } from "bun:test"
import { orderProjects } from "./order"

const project = (worktree: string, created: number) => ({ worktree, time: { created, updated: 0, active: 0 } })

const names = (items: readonly { worktree: string }[]) => items.map((item) => item.worktree)

test("orders by creation time, newest first, by default", () => {
  expect(names(orderProjects([project("a", 1), project("c", 3), project("b", 2)], [], []))).toEqual(["c", "b", "a"])
})

test("keeps dragged positions and puts projects created since at the top", () => {
  const projects = [project("a", 1), project("b", 2), project("c", 3), project("d", 4)]

  expect(names(orderProjects(projects, [], ["a", "c"]))).toEqual(["d", "b", "a", "c"])
})

test("lists pinned projects first in their dragged order", () => {
  const projects = [project("a", 1), project("b", 2), project("c", 3)]

  expect(names(orderProjects(projects, ["a", "c"], ["a", "c", "b"]))).toEqual(["a", "c", "b"])
  expect(names(orderProjects(projects, ["b"], []))).toEqual(["b", "c", "a"])
})
