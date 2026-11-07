import { For, Show, createMemo } from "solid-js"
import { useLanguage } from "@/runtime/i18n/language"

const WIDTH = 240
const HEIGHT = 56
const PAD = 4
const DAY_MS = 86_400_000

/** Tokens per day as a line. `daily` is oldest first and ends today (UTC); each day has a hover label. */
export function UsageChart(props: { daily: ReadonlyArray<number>; label: string }) {
  const language = useLanguage()
  const date = createMemo(() => new Intl.DateTimeFormat(language.intl(), { dateStyle: "medium", timeZone: "UTC" }))
  const number = createMemo(() => new Intl.NumberFormat(language.intl()))
  const total = createMemo(() => props.daily.reduce((sum, value) => sum + value, 0))
  const points = createMemo(() => {
    const max = Math.max(...props.daily, 1)
    const step = (WIDTH - PAD * 2) / Math.max(props.daily.length - 1, 1)
    return props.daily.map((value, index) => ({
      x: PAD + index * step,
      y: HEIGHT - PAD - (value / max) * (HEIGHT - PAD * 2),
      value,
      step,
    }))
  })
  const today = Math.floor(Date.now() / DAY_MS)

  return (
    <Show
      when={total() > 0}
      fallback={<p data-slot="landing-chart-empty">{language.t("landing.chart.empty")}</p>}
    >
      <svg
        data-slot="landing-chart"
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        preserveAspectRatio="none"
        role="img"
        aria-label={language.t("landing.chart.label", { name: props.label, count: number().format(total()) })}
      >
        <polygon data-slot="landing-chart-area" points={`${PAD},${HEIGHT} ${points().map((point) => `${point.x},${point.y}`).join(" ")} ${WIDTH - PAD},${HEIGHT}`} />
        <polyline points={points().map((point) => `${point.x},${point.y}`).join(" ")} />
        <For each={points()}>
          {(point, index) => (
            <rect x={point.x - point.step / 2} y={0} width={point.step} height={HEIGHT} data-slot="landing-chart-day">
              <title>
                {date().format((today - (points().length - 1 - index())) * DAY_MS)}: {number().format(point.value)}
              </title>
            </rect>
          )}
        </For>
      </svg>
      <span data-slot="landing-chart-total">{language.t("landing.chart.total", { count: number().format(total()) })}</span>
    </Show>
  )
}
