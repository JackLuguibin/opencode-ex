import { For, Show, createEffect, createMemo, createSignal, on, onCleanup } from "solid-js"
import { Button } from "@opencode/ui/button"
import { Icon } from "@opencode/ui/icon"
import { Loader } from "@opencode/ui/loader"
import { Brand } from "@/brand"
import { useLanguage } from "@/runtime/i18n/language"
import type { AccountPublicOrganization } from "@/identity/api"
import { UsageChart } from "./chart"
import { Mech } from "./mech"
import "./landing.css"

const features = [
  { icon: "workspace", title: "landing.feature.organizations.title", body: "landing.feature.organizations.body" },
  { icon: "folder", title: "landing.feature.shared.title", body: "landing.feature.shared.body" },
  { icon: "outline-sliders", title: "landing.feature.queue.title", body: "landing.feature.queue.body" },
  { icon: "refresh", title: "landing.feature.schedule.title", body: "landing.feature.schedule.body" },
  { icon: "comment", title: "landing.feature.sessions.title", body: "landing.feature.sessions.body" },
  { icon: "outline-brain", title: "landing.feature.models.title", body: "landing.feature.models.body" },
  { icon: "filetree", title: "landing.feature.files.title", body: "landing.feature.files.body" },
  { icon: "review", title: "landing.feature.review.title", body: "landing.feature.review.body" },
  { icon: "outline-console", title: "landing.feature.terminal.title", body: "landing.feature.terminal.body" },
  { icon: "waveform", title: "landing.feature.voice.title", body: "landing.feature.voice.body" },
  { icon: "window-analytics", title: "landing.feature.usage.title", body: "landing.feature.usage.body" },
  { icon: "lock", title: "landing.feature.roles.title", body: "landing.feature.roles.body" },
] as const

/** Eases a number from its last value to `target`; jumps straight there when the user prefers reduced motion. */
function countUp(target: () => number) {
  const [value, setValue] = createSignal(0)
  createEffect(
    on(target, (to) => {
      const from = value()
      if (matchMedia("(prefers-reduced-motion: reduce)").matches) return setValue(to)
      const start = performance.now()
      let frame = requestAnimationFrame(function tick(now) {
        const progress = Math.min((now - start) / 900, 1)
        setValue(from + (to - from) * (1 - (1 - progress) ** 3))
        if (progress < 1) frame = requestAnimationFrame(tick)
      })
      onCleanup(() => cancelAnimationFrame(frame))
    }),
  )
  return value
}

/** Points the card glow at the pointer. */
function spotlight(event: PointerEvent) {
  const card = (event.target as Element).closest<HTMLElement>("[data-spot]")
  if (!card) return
  const box = card.getBoundingClientRect()
  card.style.setProperty("--spot-x", `${event.clientX - box.left}px`)
  card.style.setProperty("--spot-y", `${event.clientY - box.top}px`)
  card.style.setProperty("--tilt-x", `${((event.clientY - box.top) / box.height - 0.5) * -6}deg`)
  card.style.setProperty("--tilt-y", `${((event.clientX - box.left) / box.width - 0.5) * 8}deg`)
}

/** The start page: what the product is, which organizations use it, and what it can do. */
export function LandingView(props: {
  organizations: ReadonlyArray<AccountPublicOrganization> | undefined
  action: { label: string; onClick: () => void }
}) {
  const language = useLanguage()
  const date = createMemo(() => new Intl.DateTimeFormat(language.intl(), { dateStyle: "medium" }))
  const compact = createMemo(() => new Intl.NumberFormat(language.intl(), { notation: "compact", maximumFractionDigits: 1 }))
  const totals = createMemo(() => {
    const list = props.organizations ?? []
    return {
      organizations: list.length,
      members: list.reduce((sum, item) => sum + item.members, 0),
      admins: list.reduce((sum, item) => sum + item.admins, 0),
      tokens: list.reduce((sum, item) => sum + item.tokens, 0),
      projects: list.reduce((sum, item) => sum + item.projects, 0),
      sessions: list.reduce((sum, item) => sum + item.sessions, 0),
      daily: Array.from({ length: 30 }, (_, day) => list.reduce((sum, item) => sum + (item.daily[day] ?? 0), 0)),
    }
  })

  const shown = {
    organizations: countUp(() => totals().organizations),
    members: countUp(() => totals().members),
    admins: countUp(() => totals().admins),
    projects: countUp(() => totals().projects),
    sessions: countUp(() => totals().sessions),
    tokens: countUp(() => totals().tokens),
  }
  const stats = [
    { label: "landing.stats.organizations", value: () => String(Math.round(shown.organizations())) },
    { label: "landing.stats.members", value: () => String(Math.round(shown.members())) },
    { label: "landing.stats.admins", value: () => String(Math.round(shown.admins())) },
    { label: "landing.stats.projects", value: () => compact().format(Math.round(shown.projects())) },
    { label: "landing.stats.sessions", value: () => compact().format(Math.round(shown.sessions())) },
    { label: "landing.stats.tokens", value: () => compact().format(Math.round(shown.tokens())) },
  ] as const

  return (
    <main data-component="landing" data-scrollable onPointerMove={spotlight}>
      <Mech />
      <div class="landing-top">
        <section class="landing-hero">
          <div class="landing-brand">
            <Brand fade={false} muted={false} />
          </div>
          <h1>{language.t("landing.title")}</h1>
          <p>{language.t("landing.subtitle")}</p>
          <Button type="button" variant="contrast" data-action="landing-enter" onClick={props.action.onClick}>
            {props.action.label}
          </Button>
        </section>

        <Show when={totals().organizations > 0}>
          <section class="landing-panel" data-component="landing-stats">
            <dl class="landing-stats">
              <For each={stats}>
                {(item, index) => (
                  <div style={{ "--i": index() }}>
                    <dt>{language.t(item.label)}</dt>
                    <dd>{item.value()}</dd>
                  </div>
                )}
              </For>
            </dl>
            <div class="landing-trend" data-component="landing-trend">
              <UsageChart daily={totals().daily} label={language.t("landing.stats.organizations")} />
            </div>
          </section>
        </Show>
      </div>

      <section class="landing-section landing-orgs" aria-labelledby="landing-organizations">
        <h2 id="landing-organizations">{language.t("landing.organizations.title")}</h2>
        <Show
          when={props.organizations}
          fallback={
            <div class="landing-loading">
              <Loader />
            </div>
          }
        >
          {(organizations) => (
            <Show
              when={organizations().length > 0}
              fallback={<p class="landing-empty">{language.t("landing.organizations.empty")}</p>}
            >
              <ul class="landing-organizations">
                <For each={organizations()}>
                  {(organization, index) => (
                    <li data-slot="landing-organization" data-spot style={{ "--i": index() }}>
                      <header>
                        <span data-slot="landing-avatar" aria-hidden="true">
                          {Array.from(organization.name)[0]?.toUpperCase()}
                        </span>
                        <h3>{organization.name}</h3>
                      </header>
                      <p data-empty={organization.intro ? undefined : ""}>
                        {organization.intro ?? language.t("landing.organization.noIntro")}
                      </p>
                      <div data-slot="landing-chart-box">
                        <UsageChart daily={organization.daily} label={organization.name} />
                      </div>
                      <div data-slot="landing-organization-meta">
                        <span>{language.plural("landing.organization.projects", organization.projects)}</span>
                        <span>{language.plural("landing.organization.sessions", organization.sessions)}</span>
                        <span>{language.plural("landing.organization.members", organization.members)}</span>
                        <span>{language.plural("landing.organization.admins", organization.admins)}</span>
                        <span>{language.t("landing.organization.tokens", { count: compact().format(organization.tokens) })}</span>
                        <span>
                          {language.t("landing.organization.created", { date: date().format(organization.created) })}
                        </span>
                      </div>
                    </li>
                  )}
                </For>
              </ul>
            </Show>
          )}
        </Show>
      </section>

      <ul class="landing-features" aria-label={language.t("landing.features.title")}>
        <For each={features}>
          {(feature, index) => (
            <li data-spot style={{ "--i": index() }}>
              <span data-slot="landing-feature-icon">
                <Icon name={feature.icon} />
              </span>
              <div>
                <h3>{language.t(feature.title)}</h3>
                <p>{language.t(feature.body)}</p>
              </div>
            </li>
          )}
        </For>
      </ul>
    </main>
  )
}
