# Manual app performance suite

The app's high-volume performance diagnostics live under `packages/app/e2e/performance` and are excluded from normal local and CI Playwright discovery. The benchmark config builds the app and serves the production bundle before running scenarios serially.

The `devex` category is the explicit exception to the production-build rule. It measures development commands from submission through a user-visible ready state and has its own Playwright configuration.

Run the suite explicitly from `packages/app`:

```sh
bun run test:bench
```

Desktop startup benchmarks are excluded from opencode-ex.

## Retained renderer memory

Run the catalog workload against the production app bundle:

```sh
bunx playwright test --config e2e/performance/playwright.config.ts \
  timeline/provider-memory-benchmark.spec.ts --repeat-each=3
```

`PROVIDER_MEMORY_MODELS` defaults to 1,200 and `PROVIDER_MEMORY_SWITCHES` defaults to 10. Each sample records Chromium's `Runtime.getHeapUsage` and `Memory.getDOMCounters` after an explicit garbage collection. This measures retained state, not allocation peaks or normal GC timing. It does not include worker heaps, the Electron main/GPU processes, or the OpenCode server, and must not be reported as total desktop RAM. Use identical model counts and navigation sequences for before/after comparisons.

## Chrome traces

Set `OPENCODE_PERFORMANCE_TRACE_DIR` to emit a standard Chrome DevTools trace for every benchmark page automatically:

```sh
OPENCODE_PERFORMANCE_TRACE_DIR=/tmp/opencode-performance-traces \
bunx playwright test --config e2e/performance/playwright.config.ts \
  timeline/session-tab-switch-benchmark.spec.ts
```

The emitted JSON is a standard Chrome trace and can be loaded directly into the Chrome DevTools Performance panel. `devtools-tracing` can optionally inspect it from the command line without adding package scripts or dependencies:

Trace capture follows [Puppeteer's tracing lifecycle](https://pptr.dev/api/puppeteer.tracing), using Chrome's `ReturnAsStream` transfer mode and failing when Chromium reports trace data loss. V8 CPU sample stacks support attribution through the frozen build's source maps. Set `OPENCODE_PERFORMANCE_STACK_TRACE=1` only when per-event timeline stacks are needed; they add substantial overhead. Keep profiled runs separate from latency distributions, including when comparing the stack-capture modes.

```sh
bunx devtools-tracing stats <trace-path-from-BENCHMARK_PAGE>
```

INP analysis requires a trace with a supported navigation/interaction insight. Selector statistics require a trace captured with `OPENCODE_PERFORMANCE_SELECTOR_TRACE=1`.

`e2e/performance/playwright.uncapped.config.ts` disables Chromium frame-rate limiting for explicit uncapped diagnostics. Native product benchmarks should use the default Playwright configuration.
