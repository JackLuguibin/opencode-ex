export * as OrganizationSandbox from "./organization-sandbox.js"

import { rewriteSpawns } from "@opencode/util/cross-spawn-spawner"
import { FSUtil } from "@opencode/util/fs-util"
import { Path } from "@opencode/util/global"
import { mkdirSync, realpathSync, renameSync, writeFileSync } from "fs"
import path from "path"

/** The directory that holds every organization's directory: `OPENCODE_ORGANIZATIONS_ROOT`, else inside the data directory. */
export function organizations(data: string) {
  const configured = process.env.OPENCODE_ORGANIZATIONS_ROOT?.trim()
  return configured && path.isAbsolute(configured) ? configured : path.join(data, "organizations")
}

/** The organization directory a Location lives in, when it lives in one; those sessions may not leave it. */
export function root(data: string, directory: string) {
  const base = organizations(data)
  if (!FSUtil.contains(base, directory)) return
  const [organizationID] = path.relative(base, directory).split(path.sep)
  return organizationID ? path.join(base, organizationID) : undefined
}

export interface Confinement {
  readonly root: string
  readonly data: string
  readonly home: string
  /** Directories outside the organization that stay readable, such as the skills every organization shares. */
  readonly readable?: readonly string[]
}

type Canonical = Confinement & { readonly organizations: string }

/**
 * Directories organization sessions may read besides their own: the skills every organization shares, and whatever
 * the operator lists in `OPENCODE_SANDBOX_READ` (colon separated), typically toolchains such as `~/.nvm` that live in
 * a home directory the sandbox otherwise closes.
 */
export function readable(config: string) {
  const extra = (process.env.OPENCODE_SANDBOX_READ ?? "").split(path.delimiter).filter((item) => path.isAbsolute(item))
  return [path.join(config, "skills"), ...extra]
}

const SANDBOX_EXEC = "/usr/bin/sandbox-exec"
const ENV = "/usr/bin/env"

// What a command in an organization inherits from the server's own environment. Everything else there (database and
// Redis URLs, signing keys, provider tokens) would be readable with `env` and would reach shared stores no file rule
// protects, so those names are unset; variables a session sets for itself under other names are untouched.
const INHERITED = /^(PATH|HOME|USER|LOGNAME|SHELL|LANG|LANGUAGE|LC_\w+|TERM|COLORTERM|TZ|PWD|TMPDIR|(HTTPS?|ALL|NO)_PROXY|SSL_CERT_\w+|NODE_EXTRA_CA_CERTS|OPENCODE_TERMINAL)$/i

function secrets() {
  return Object.keys(process.env).filter((name) => !INHERITED.test(name))
}

// `/run/systemd/resolve` is where /etc/resolv.conf points on systemd hosts. Missing entries are skipped.
const LINUX_SYSTEM = ["/usr", "/bin", "/sbin", "/lib", "/lib32", "/lib64", "/libx32", "/etc", "/opt", "/sys", "/run/systemd/resolve"]

/**
 * Wraps a command so the operating system, not the tools, keeps it inside its organization directory: files outside it
 * are unreadable (the data directory and home hold every organization's files, accounts and credentials) and
 * unwritable. Commands can't be vetted by parsing them, so this is the boundary that also covers `cd`, symlinks and
 * scripts. There is no fallback: where no sandbox exists the command must not run.
 */
export function wrap(confinement: Confinement, command: string, args: readonly string[]) {
  // The sandbox program itself starts without them: bwrap's own process stays visible in /proc, with its environment.
  const clean = (program: string, rest: readonly string[]) => ({
    command: ENV,
    args: [...secrets().flatMap((name) => ["-u", name]), program, ...rest],
  })
  if (process.platform === "darwin") return clean(SANDBOX_EXEC, ["-p", profile(confinement), command, ...args])
  const bwrap = process.platform === "linux" ? Bun.which("bwrap") : null
  if (bwrap) {
    const real = canonical(confinement)
    return clean(bwrap, [
      // Only what programs need to run is mounted, as under sandbox-exec: any other directory (`/root`, `/srv`,
      // `/home/<other>`, the deployment's env file) does not exist inside, so `cd` and `ls` find nothing there.
      ...LINUX_SYSTEM.flatMap((item) => ["--ro-bind-try", item, item]),
      "--dev", "/dev",
      // A private pid namespace, or /proc would list the server's processes and their environments.
      "--unshare-pid",
      // Opt-in: with no network namespace a command can reach whatever listens on this machine's loopback (the
      // execution layer, Postgres, Redis); with one it can reach nothing, including package registries.
      ...(process.env.OPENCODE_SANDBOX_NETWORK === "off" ? ["--unshare-net"] : []),
      "--proc", "/proc",
      // The root is read-only, so scratch space is private and writable, as it is under sandbox-exec.
      "--tmpfs", "/tmp",
      "--tmpfs", real.home,
      "--tmpfs", real.data,
      // A configured organizations root can sit outside the data directory; the other organizations stay closed.
      "--tmpfs", real.organizations,
      ...(real.readable ?? []).flatMap((item) => ["--ro-bind-try", item, item]),
      "--bind", real.root, real.root,
      // The organization's own `.opencode` is configuration the server loads and runs (plugins), so the commands it
      // starts may read it but never change it. It is created first so that it is a mount point to protect.
      ...protectedConfig(real.root),
      // Interactive bash reads these, so `cd` out of the organization is refused there (see `guard`).
      ...[".bashrc", ".bash_profile"].flatMap((name) => ["--ro-bind", guard(real), path.join(real.home, name)]),
      // The directories above the organization exist only as mount points: read-only, so only the organization's own
      // directory (and /tmp) takes writes. This comes last because the mount points are made while these are writable.
      ...[real.organizations, real.data, real.home, "/"].flatMap((item) => ["--remount-ro", item]),
      "--die-with-parent",
      "--",
      command,
      ...args,
    ])
  }
  throw new Error("Sessions in an organization need an operating system sandbox (sandbox-exec or bubblewrap)")
}

/** The command a wrapped command line was built from; anything else is returned as it is. */
export function unwrap(commandLine: readonly string[]) {
  if (commandLine[0] !== ENV) return commandLine
  let at = 1
  while (commandLine[at] === "-u") at += 2
  const sandbox = commandLine.slice(at)
  if (sandbox[0] === SANDBOX_EXEC && sandbox[1] === "-p") return sandbox.slice(3)
  const separator = sandbox.indexOf("--")
  return path.basename(sandbox[0] ?? "") === "bwrap" && separator >= 0 ? sandbox.slice(separator + 1) : commandLine
}

function protectedConfig(root: string) {
  const config = path.join(root, ".opencode")
  mkdirSync(config, { recursive: true })
  return ["--ro-bind", config, config]
}

// The server itself runs git, formatters, ripgrep and `!command` templates in project directories, and what those read
// (a repository's config, a project's node_modules, a command file) is written by the organization's members. So every
// process started in an organization's directory is confined like a terminal; the ones that already are stay as they are.
rewriteSpawns((spawn) => {
  if (!spawn.cwd) return spawn
  const confined = root(Path.data, spawn.cwd)
  if (!confined) return spawn
  if (unwrap([spawn.command, ...spawn.args]).length !== spawn.args.length + 1) return spawn
  return wrap(
    { root: confined, data: Path.data, home: Path.home, readable: [...readable(Path.config), Path.bin] },
    spawn.command,
    spawn.args,
  )
})

/**
 * A start-up file for interactive bash that makes `cd` refuse to leave the organization directory. This is only a
 * convenience for people using the terminal: `builtin cd`, `pushd` or another shell go around it, and nothing in it is
 * trusted. The boundary is the mount namespace, where the directories above the organization are empty and read-only.
 */
const guards = new Map<string, string>()

function guard(real: Canonical) {
  const known = guards.get(real.root)
  if (known) return known
  const script = [
    "case $- in *i*) ;; *) return 0 2>/dev/null || exit 0 ;; esac",
    `__opencode_root='${real.root.replaceAll("'", "'\\''")}'`,
    "cd() {",
    '  if [ $# -eq 0 ]; then builtin cd "$__opencode_root"; return; fi',
    '  local before="$PWD"',
    '  builtin cd "$@" || return',
    '  case "$PWD/" in "$__opencode_root"/*) ;; *) builtin cd "$before"; echo "cd: leaving the organization directory is not allowed" >&2; return 1 ;; esac',
    "}",
    "",
  ].join("\n")
  const file = path.join(real.data, "sandbox", `${path.basename(real.root)}.bashrc`)
  mkdirSync(path.dirname(file), { recursive: true })
  const temporary = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}`
  writeFileSync(temporary, script)
  renameSync(temporary, file)
  guards.set(real.root, file)
  return file
}

function canonical(confinement: Confinement): Canonical {
  const resolve = (value: string) => {
    try {
      return realpathSync(value)
    } catch {
      return path.resolve(value)
    }
  }
  return {
    root: resolve(confinement.root),
    data: resolve(confinement.data),
    home: resolve(confinement.home),
    organizations: resolve(organizations(confinement.data)),
    readable: (confinement.readable ?? []).map(resolve),
  }
}

// Rules apply last-match-wins, and `file-read-data` is named explicitly in the later rules because a wildcard `file-read*`
// does not override an earlier rule for that specific operation. Contents and listings (`file-read-data`) are closed everywhere, then only what programs
// need to run is reopened: system directories, scratch space, and the organization's own directory. So `ls ..` or
// `ls /Users` show nothing. Metadata stays readable because path lookups (`cd`, `realpath`) need it, and the root
// directory's own entry names must stay listable or no process starts (the loader reads it); nothing below it opens up.
const SYSTEM = ["/usr", "/bin", "/sbin", "/System", "/Library", "/Applications", "/opt", "/dev", "/private/etc", "/private/var/db", "/private/var/select"]
const SCRATCH = ["/private/tmp", "/private/var/folders"]

function profile(confinement: Confinement) {
  const { root, data, home, readable, organizations: closed } = canonical(confinement)
  const subpaths = (values: readonly string[]) => values.map((value) => `(subpath ${JSON.stringify(value)})`).join(" ")
  return [
    "(version 1)",
    "(allow default)",
    '(deny file-write* (subpath "/"))',
    `(allow file-write* (subpath "/dev") ${subpaths(SCRATCH)})`,
    '(deny file-read-data (subpath "/"))',
    `(allow file-read-data (literal "/") ${subpaths([...SYSTEM, ...SCRATCH])})`,
    `(deny file-read-data file-read* file-write* ${subpaths([home, data, closed])})`,
    ...(readable?.length ? [`(allow file-read-data file-read* ${subpaths(readable)})`] : []),
    // Git refuses to run when it can't read the user's config, so that one file stays readable.
    `(allow file-read-data file-read* (literal ${JSON.stringify(path.join(home, ".gitconfig"))}))`,
    `(allow file-read-data file-read* file-write* ${subpaths([root])})`,
    // Configuration the server loads and runs (plugins) can be read from here, never changed.
    `(deny file-write* ${subpaths([path.join(root, ".opencode")])})`,
  ].join("\n")
}
