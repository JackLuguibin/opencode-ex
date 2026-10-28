export * as OrganizationSandbox from "./organization-sandbox.js"

import { FSUtil } from "@opencode/util/fs-util"
import { realpathSync } from "fs"
import path from "path"

/** The organization directory a Location lives in, when it lives in one; those sessions may not leave it. */
export function root(data: string, directory: string) {
  const organizations = path.join(data, "organizations")
  if (!FSUtil.contains(organizations, directory)) return
  const [organizationID] = path.relative(organizations, directory).split(path.sep)
  return organizationID ? path.join(organizations, organizationID) : undefined
}

export interface Confinement {
  readonly root: string
  readonly data: string
  readonly home: string
}

const SANDBOX_EXEC = "/usr/bin/sandbox-exec"

/**
 * Wraps a command so the operating system, not the tools, keeps it inside its organization directory: files outside it
 * are unreadable (the data directory and home hold every organization's files, accounts and credentials) and
 * unwritable. Commands can't be vetted by parsing them, so this is the boundary that also covers `cd`, symlinks and
 * scripts. There is no fallback: where no sandbox exists the command must not run.
 */
export function wrap(confinement: Confinement, command: string, args: readonly string[]) {
  if (process.platform === "darwin") {
    return { command: SANDBOX_EXEC, args: ["-p", profile(confinement), command, ...args] }
  }
  const bwrap = process.platform === "linux" ? Bun.which("bwrap") : null
  if (bwrap) {
    const real = canonical(confinement)
    return {
      command: bwrap,
      args: [
        "--ro-bind", "/", "/",
        "--dev", "/dev",
        "--proc", "/proc",
        "--tmpfs", real.home,
        "--tmpfs", real.data,
        "--bind", real.root, real.root,
        "--die-with-parent",
        "--",
        command,
        ...args,
      ],
    }
  }
  throw new Error("Sessions in an organization need an operating system sandbox (sandbox-exec or bubblewrap)")
}

/** The command a wrapped command line was built from; anything else is returned as it is. */
export function unwrap(commandLine: readonly string[]) {
  if (commandLine[0] === SANDBOX_EXEC && commandLine[1] === "-p") return commandLine.slice(3)
  if (path.basename(commandLine[0] ?? "") === "bwrap") {
    const separator = commandLine.indexOf("--")
    if (separator >= 0) return commandLine.slice(separator + 1)
  }
  return commandLine
}

function canonical(confinement: Confinement): Confinement {
  const resolve = (value: string) => {
    try {
      return realpathSync(value)
    } catch {
      return path.resolve(value)
    }
  }
  return { root: resolve(confinement.root), data: resolve(confinement.data), home: resolve(confinement.home) }
}

// Rules apply last-match-wins, and `file-read-data` is named explicitly in the later rules because a wildcard `file-read*`
// does not override an earlier rule for that specific operation. Contents and listings (`file-read-data`) are closed everywhere, then only what programs
// need to run is reopened: system directories, scratch space, and the organization's own directory. So `ls ..` or
// `ls /Users` show nothing. Metadata stays readable because path lookups (`cd`, `realpath`) need it, and the root
// directory's own entry names must stay listable or no process starts (the loader reads it); nothing below it opens up.
const SYSTEM = ["/usr", "/bin", "/sbin", "/System", "/Library", "/Applications", "/opt", "/dev", "/private/etc", "/private/var/db", "/private/var/select"]
const SCRATCH = ["/private/tmp", "/private/var/folders"]

function profile(confinement: Confinement) {
  const { root, data, home } = canonical(confinement)
  const subpaths = (values: readonly string[]) => values.map((value) => `(subpath ${JSON.stringify(value)})`).join(" ")
  return [
    "(version 1)",
    "(allow default)",
    '(deny file-write* (subpath "/"))',
    `(allow file-write* (subpath "/dev") ${subpaths(SCRATCH)})`,
    '(deny file-read-data (subpath "/"))',
    `(allow file-read-data (literal "/") ${subpaths([...SYSTEM, ...SCRATCH])})`,
    `(deny file-read-data file-read* file-write* ${subpaths([home, data])})`,
    // Git refuses to run when it can't read the user's config, so that one file stays readable.
    `(allow file-read-data file-read* (literal ${JSON.stringify(path.join(home, ".gitconfig"))}))`,
    `(allow file-read-data file-read* file-write* ${subpaths([root])})`,
  ].join("\n")
}
