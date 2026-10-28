import { expect, test } from "bun:test"
import { chosenPaths, type PickNode } from "./download-selection"

const file = (path: string, checked: boolean): PickNode => ({
  path,
  type: "file",
  checked,
  listed: false,
  children: [],
})

const directory = (path: string, checked: boolean, children: string[], listed = false): PickNode => ({
  path,
  type: "directory",
  checked,
  listed,
  children,
})

test("a fully checked folder downloads the whole directory", () => {
  const nodes = {
    "hello.py": file("hello.py", true),
    src: directory("src", true, []),
  }

  expect(chosenPaths(nodes, ["hello.py", "src"])).toBeUndefined()
})

test("clearing one file keeps the other selected paths", () => {
  const nodes = {
    "hello.py": file("hello.py", true),
    "notes.txt": file("notes.txt", false),
    src: directory("src", true, []),
  }

  expect(chosenPaths(nodes, ["hello.py", "notes.txt", "src"])).toEqual(["hello.py", "src"])
})

test("clearing a file inside a folder keeps its siblings", () => {
  const nodes = {
    src: directory("src", true, ["src/hello.py", "src/skip.txt"], true),
    "src/hello.py": file("src/hello.py", true),
    "src/skip.txt": file("src/skip.txt", false),
  }

  expect(chosenPaths(nodes, ["src"])).toEqual(["src/hello.py"])
})

test("clearing everything selects nothing", () => {
  const nodes = {
    "hello.py": file("hello.py", false),
    src: directory("src", false, []),
  }

  expect(chosenPaths(nodes, ["hello.py", "src"])).toEqual([])
})
