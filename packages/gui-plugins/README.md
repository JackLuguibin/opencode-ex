# Built-in Web GUI plugins

opencode-ex retains the built-in Web features in this package. The desktop application and its native plugins have been removed.

## Active built-ins

- `context` and `btw`: session context and side conversations.
- `debug`: browser diagnostics, motion tools and the component lab.
- `terminal`: server-backed terminal.
- `file`, `review` and `details`: file browsing, changes and session details.
- `microsoft-office`: document previews.
- `sources`: source and reference panels.

`src/renderer.ts` composes their window entries. `src/main.ts` retains the declaration inventory for compatibility and has no native main-process entries.

## Plugin SDK

The public SDK is in `../plugin/src/gui` and is imported through `@opencode/plugin/gui`. Each plugin owns its declarations, stores, contracts and translations. The host assigns its id. Use the existing `file` and `review` plugins as implementation references.

Keep host-specific helpers in `@opencode/plugin/gui/builtin`; public SDK modules must not import them. Window setup remains synchronous under a Solid owner; asynchronous work must observe cancellation and clean up its resources. Registries, subscriptions and timers must not outlive the plugin instance.

The `gui/main` compatibility module retains generic storage, logging and IPC declarations, but no longer exports Electron window, native embed or menubar APIs. Existing server and Web IPC contracts remain available.

## Removed desktop features

The SSH, WSL, native browser, desktop pairing and updater plugins are removed. Electron memory diagnostics and their dedicated tests are removed, while browser diagnostics remain. The Web server connection and pairing UI is owned by `packages/app/src/servers/connect` and remains available.

The browser contract stays in the SDK because file and source panels consume it optionally; it does not install Electron or launch a native browser.

## Validation

Run `bun run lint:changed HEAD` and `bun run check` from the repository root. Run GUI plugin tests from this package with `bun test`. Web plugin host and graph scenarios live in `packages/app/component-tests` and use the shared stories harness.
