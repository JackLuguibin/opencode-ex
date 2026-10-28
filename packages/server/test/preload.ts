import fs from "node:fs"
import os from "node:os"
import path from "node:path"

// Tests create organization directories, install packages and write config. Without an isolated home they would do
// that in the developer's real one, so every test run gets a throwaway home before anything reads the global paths.
const home = fs.mkdtempSync(path.join(os.tmpdir(), "opencode-server-test-"))
process.env.HOME = home
process.env.XDG_CONFIG_HOME = path.join(home, ".config")
process.env.XDG_DATA_HOME = path.join(home, ".local", "share")
process.env.XDG_CACHE_HOME = path.join(home, ".cache")
process.env.XDG_STATE_HOME = path.join(home, ".local", "state")
