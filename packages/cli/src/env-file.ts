import { readFileSync } from "node:fs"
import { parseEnv } from "node:util"

// A deployment keeps its settings in one env file: `opencode serve --env-file /etc/opencode/opencode.env`, or
// OPENCODE_ENV_FILE. The compiled binary does not read a .env from the working directory on its own. Variables already
// in the environment win, so a container or service manager can still override single values. This runs before the
// other modules load because they read the environment as they initialize.
const index = process.argv.findIndex((arg) => arg === "--env-file" || arg.startsWith("--env-file="))
const flag = index < 0 ? undefined : process.argv[index]!
const path = flag?.startsWith("--env-file=") ? flag.slice("--env-file=".length) : flag ? process.argv[index + 1] : undefined
if (flag) process.argv.splice(index, flag.includes("=") ? 1 : 2)
const file = path ?? process.env.OPENCODE_ENV_FILE
if (flag && !path) {
  console.error("--env-file needs a path")
  process.exit(1)
}
if (file) {
  const text = (() => {
    try {
      return readFileSync(file, "utf8")
    } catch {
      console.error(`Cannot read env file ${file}`)
      process.exit(1)
    }
  })()
  Object.entries(parseEnv(text)).forEach(([key, value]) => {
    if (process.env[key] === undefined && value !== undefined) process.env[key] = value
  })
}
