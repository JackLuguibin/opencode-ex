import { createEffect, createMemo, createSignal, For, Show } from "solid-js"
import { Button } from "@opencode/ui/button"
import { Icon } from "@opencode/ui/icon"
import { useLanguage } from "@/runtime/i18n/language"
import "./download-policy.css"

export type DownloadPolicy = { readonly extensions: ReadonlyArray<string>; readonly maxBytes: number }

// Mirrors the defaults the server applies to an organization nobody has configured.
const TEXT = ["csv", "ini", "json", "log", "md", "toml", "txt", "xml", "yaml", "yml"]
const MB = 1024 * 1024
const SIZES = [1, 5, 10, 50]

type Mode = "text" | "custom" | "any"

/** Which file types and how large a file members of an organization may download from the workspace. */
export function DownloadPolicyEditor(props: {
  policy: DownloadPolicy
  pending: boolean
  onSave: (policy: DownloadPolicy) => void
}) {
  const language = useLanguage()
  const [extensions, setExtensions] = createSignal<string[]>([])
  const [size, setSize] = createSignal("1")
  const [typed, setTyped] = createSignal("")
  const [custom, setCustom] = createSignal(false)

  createEffect(() => {
    setExtensions([...props.policy.extensions])
    setSize(String(props.policy.maxBytes / MB))
    setCustom(false)
  })

  const mode = createMemo<Mode>(() => {
    if (extensions().includes("*")) return "any"
    if (!custom() && extensions().length === TEXT.length && TEXT.every((item) => extensions().includes(item))) return "text"
    return "custom"
  })
  const bytes = () => Math.round(Number(size()) * MB)
  const valid = () => Number.isFinite(bytes()) && bytes() >= 0
  const dirty = () =>
    JSON.stringify([...extensions()].sort()) !== JSON.stringify([...props.policy.extensions].sort()) ||
    bytes() !== props.policy.maxBytes

  const pick = (next: Mode) => {
    if (next === "text") setExtensions([...TEXT])
    if (next === "any") setExtensions(["*"])
    if (next === "custom") setExtensions(mode() === "any" ? [] : extensions())
    setCustom(next === "custom")
  }
  const add = () => {
    const parts = typed()
      .split(/[\s,，;；]+/)
      .map((item) => item.replace(/^\.+/, "").toLowerCase())
      .filter((item) => /^[a-z0-9_+-]{1,16}$/.test(item))
    setTyped("")
    if (parts.length) setExtensions([...new Set([...extensions(), ...parts])].sort())
  }

  return (
    <section class="download-policy">
      <header>
        <h3>{language.t("account.admin.downloads")}</h3>
        <p>{language.t("account.admin.downloads.description")}</p>
      </header>
      <div class="download-policy-card" aria-busy={props.pending}>
        <div class="download-policy-row">
          <span class="download-policy-label">{language.t("account.admin.downloads.types")}</span>
          <div class="download-policy-segments" role="radiogroup" aria-label={language.t("account.admin.downloads.types")}>
            <For each={["text", "custom", "any"] as const}>
              {(item) => (
                <button
                  type="button"
                  role="radio"
                  aria-checked={mode() === item}
                  disabled={props.pending}
                  onClick={() => pick(item)}
                >
                  {language.t(`account.admin.downloads.mode.${item}`)}
                </button>
              )}
            </For>
          </div>
          <Show
            when={mode() !== "any"}
            fallback={<p class="download-policy-note">{language.t("account.admin.downloads.any")}</p>}
          >
            <div class="download-policy-chips">
              <For each={extensions()}>
                {(item) => (
                  <span class="download-policy-chip">
                    .{item}
                    <button
                      type="button"
                      aria-label={language.t("account.admin.downloads.remove", { name: item })}
                      disabled={props.pending}
                      onClick={() => {
                        setExtensions(extensions().filter((value) => value !== item))
                        setCustom(true)
                      }}
                    >
                      <Icon name="close-small" size="small" />
                    </button>
                  </span>
                )}
              </For>
              <input
                value={typed()}
                disabled={props.pending}
                placeholder={language.t("account.admin.downloads.add")}
                onInput={(event) => setTyped(event.currentTarget.value)}
                onBlur={() => {
                  add()
                  if (extensions().length) setCustom(true)
                }}
                onKeyDown={(event) => {
                  if (event.key !== "Enter" && event.key !== "," && event.key !== " ") return
                  event.preventDefault()
                  add()
                  setCustom(true)
                }}
              />
            </div>
            <Show when={extensions().length === 0}>
              <p class="download-policy-note">{language.t("account.admin.downloads.none")}</p>
            </Show>
          </Show>
        </div>
        <div class="download-policy-row">
          <span class="download-policy-label">{language.t("account.admin.downloads.size")}</span>
          <div class="download-policy-size">
            <div class="download-policy-number">
              <input
                type="number"
                min="0"
                step="any"
                value={size()}
                disabled={props.pending}
                aria-label={language.t("account.admin.downloads.size")}
                aria-invalid={!valid()}
                onInput={(event) => setSize(event.currentTarget.value)}
              />
              <span>MB</span>
            </div>
            <div class="download-policy-segments" role="group">
              <For each={SIZES}>
                {(item) => (
                  <button
                    type="button"
                    aria-pressed={Number(size()) === item}
                    disabled={props.pending}
                    onClick={() => setSize(String(item))}
                  >
                    {item} MB
                  </button>
                )}
              </For>
            </div>
          </div>
        </div>
        <footer>
          <span>{dirty() ? language.t("account.admin.downloads.unsaved") : ""}</span>
          <Button
            variant="ghost"
            disabled={props.pending || !dirty()}
            onClick={() => {
              setExtensions([...props.policy.extensions])
              setSize(String(props.policy.maxBytes / MB))
              setCustom(false)
            }}
          >
            {language.t("account.admin.downloads.revert")}
          </Button>
          <Button
            variant="contrast"
            disabled={props.pending || !dirty() || !valid()}
            onClick={() => props.onSave({ extensions: extensions(), maxBytes: bytes() })}
          >
            {language.t("account.admin.downloads.save")}
          </Button>
        </footer>
      </div>
    </section>
  )
}
