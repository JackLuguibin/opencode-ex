import { lazy, Show, Suspense } from "solid-js"
import { Command, Slot, type Plugin } from "@opencode/plugin/gui"
import type Debug from "./index"

const setup: Plugin.Setup<typeof Debug> = (ctx) => {
  const DebugBar = lazy(() => import("./bar"))
  // Motion tuning lives only in the debug bar, on the dev server and in Beta. Both are fixed at build time, so other
  // builds, prod included, drop the import and never contain knobs.
  const motionTools = import.meta.env.DEV || import.meta.env.VITE_OPENCODE_CHANNEL === "beta"
  const Motion = motionTools ? lazy(() => import("./motion")) : undefined
  const bar = ctx.stores.bar
  const visible = () => bar.value.visible
  const motion = () => bar.value.motion

  const toggle = () => {
    bar.update((draft) => {
      draft.visible = !draft.visible
    })
  }

  const hide = () => {
    bar.update((draft) => {
      draft.visible = false
    })
  }

  const toggleMotion = () => {
    bar.update((draft) => {
      draft.motion = !draft.motion
    })
  }

  ctx.add(
    Command,
    (): Command => ({
      id: "toggle",
      title: ctx.t("command.toggle"),
      group: ctx.t("command.category.view"),
      keywords: "dev bar developer tools diagnostics",
      run: toggle,
    }),
  )

  ctx.add(Slot, {
    at: "window.bottom",
    render: () => (
      <>
        <Show when={visible()}>
          <Suspense>
            <DebugBar
              diagnostics={import.meta.env.DEV}
              onClose={hide}
              motion={Motion ? { open: motion(), toggle: toggleMotion } : undefined}
              inline
            />
          </Suspense>
        </Show>
        {Motion && (
          // The Knobs workspace opens only from the debug bar's KNOBS cell, and shows while the bar does.
          <Show when={visible() && motion()}>
            <Suspense>
              <Motion title={ctx.t("motion.title")} onClose={toggleMotion} />
            </Suspense>
          </Show>
        )}
      </>
    ),
  })
}

export default setup
