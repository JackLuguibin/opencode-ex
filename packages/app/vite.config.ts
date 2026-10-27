import { sentryVitePlugin } from "@sentry/vite-plugin"
import { fileURLToPath } from "node:url"
import { defineConfig, loadEnv } from "vite"
import { localDevPassword } from "../cli/src/server-password.ts"
import desktopPlugin, { channel } from "./vite.js"
import { icons } from "./vite.icons"
import { serviceWorker } from "./vite.pwa"

const sentry =
  process.env.SENTRY_AUTH_TOKEN && process.env.SENTRY_ORG && process.env.SENTRY_PROJECT
    ? sentryVitePlugin({
        authToken: process.env.SENTRY_AUTH_TOKEN,
        org: process.env.SENTRY_ORG,
        project: process.env.SENTRY_PROJECT,
        telemetry: false,
        release: {
          name: process.env.SENTRY_RELEASE ?? process.env.VITE_SENTRY_RELEASE,
        },
        sourcemaps: {
          assets: "./dist/**",
          filesToDeleteAfterUpload: "./dist/**/*.map",
        },
      })
    : false

const repoRoot = fileURLToPath(new URL("../..", import.meta.url))

export default defineConfig(({ command, mode }) => ({
  define: {
    "import.meta.env.VITE_OPENCODE_SERVER_PASSWORD": JSON.stringify(devServerPassword(command, mode)),
  },
  plugins: [
    desktopPlugin,
    icons(channel),
    serviceWorker(fileURLToPath(new URL("./dist", import.meta.url))),
    sentry,
  ],
  server: {
    host: "0.0.0.0",
    allowedHosts: true,
    port: 3000,
  },
  build: {
    rolldownOptions:
      process.env.VITE_OPENCODE_TEST_FIXTURES === "1"
        ? { input: ["index.html", "e2e/utils/app-direction.html", "e2e/utils/windows-menu.html"] }
        : undefined,
    assetsDir: "_assets",
    target: "esnext",
    sourcemap: true,
  },
}))

function devServerPassword(command: string, mode: string) {
  if (command !== "serve" || process.env.VITE_OPENCODE_TEST_FIXTURES === "1") return ""
  const fromProcess = process.env.OPENCODE_PASSWORD || process.env.OPENCODE_SERVER_PASSWORD
  if (fromProcess) return fromProcess
  const file = loadEnv(mode, repoRoot, "")
  return file.OPENCODE_PASSWORD || file.OPENCODE_SERVER_PASSWORD || localDevPassword
}
