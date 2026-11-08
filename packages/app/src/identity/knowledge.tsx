import { createResource, For, onCleanup, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { Button } from "@opencode/ui/button"
import { useDialog } from "@opencode/ui/context/dialog"
import { Dialog, DialogBody, DialogHeader, DialogTitleGroup } from "@opencode/ui/dialog"
import { Icon } from "@opencode/ui/icon"
import { TextInput } from "@opencode/ui/text-input"
import { useLanguage } from "@/runtime/i18n/language"
import { showToast } from "@/shell/notifications/toast"
import { SettingsList } from "@/settings/list"
import {
  accountFetch,
  AccountError,
  type AccountKnowledgeBase,
  type AccountKnowledgeEntry,
  type AccountKnowledgeSearch,
  type AccountOrganization,
} from "./api"
import { useAccountOptional } from "./gate"
import { OrganizationPicker } from "./organization-picker"
import "./global-packages.css"
import "./knowledge.css"

type Panel = "entries" | "settings" | "test"

const lines = (text: string) =>
  text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)

/**
 * Knowledge bases the AI can look things up in. A platform admin creates them, decides which organizations may use them,
 * edits their entries and tunes how they are searched; everyone else only sees the bases open to their organization.
 */
export function Knowledge() {
  const account = useAccountOptional()
  const language = useLanguage()
  const dialog = useDialog()
  const [state, setState] = createStore({
    open: "",
    panel: "entries" as Panel,
    query: "",
    pending: false,
    deleting: "",
    editing: "",
    draft: [] as string[],
    probe: "",
    result: undefined as AccountKnowledgeSearch | undefined,
    job: undefined as { id: string; status: string; done: number; total: number; error: string } | undefined,
  })
  const admin = () => !!account?.session.admin
  const request = <T,>(path: string, method?: string, body?: unknown) =>
    accountFetch<T>({ url: account!.server.http.url, password: account!.server.http.password, path, method, body })

  const [bases, { refetch }] = createResource(
    () => account?.session.employeeID,
    () => request<AccountKnowledgeBase[]>("/api/knowledge/bases").catch(() => [] as AccountKnowledgeBase[]),
    { initialValue: [] },
  )
  const [organizations] = createResource(
    () => (admin() ? account?.session.employeeID : undefined),
    () => request<AccountOrganization[]>("/api/organization").catch(() => [] as AccountOrganization[]),
    { initialValue: [] },
  )
  const [entries, { refetch: refetchEntries }] = createResource(
    () => (state.open ? { base: state.open, query: state.query } : undefined),
    (input) =>
      request<AccountKnowledgeEntry[]>(
        `/api/knowledge/bases/${encodeURIComponent(input.base)}/entries?${new URLSearchParams(input.query ? { q: input.query } : {})}`,
      ).catch(() => [] as AccountKnowledgeEntry[]),
    { initialValue: [] },
  )
  const nameOf = (id: string) => (organizations.latest ?? []).find((item) => item.id === id)?.name ?? id

  const call = async <T,>(path: string, method?: string, body?: unknown) => {
    setState("pending", true)
    try {
      return { value: await request<T>(path, method, body) }
    } catch (error) {
      showToast({
        variant: "error",
        title: language.t("account.knowledge.failed"),
        description: error instanceof AccountError ? error.message : undefined,
      })
      return undefined
    } finally {
      setState("pending", false)
    }
  }

  const openBaseForm = (base?: AccountKnowledgeBase) => {
    const [form, setForm] = createStore({ name: base?.name ?? "", description: base?.description ?? "" })
    void dialog.show(() => (
      <Dialog fit>
        <DialogHeader>
          <DialogTitleGroup title={language.t(base ? "account.knowledge.rename" : "account.knowledge.add")} />
        </DialogHeader>
        <DialogBody>
          <form
            data-component="package-upload"
            onSubmit={(event) => {
              event.preventDefault()
              if (!form.name.trim()) return showToast({ variant: "error", title: language.t("account.knowledge.missing.name") })
              void call(base ? `/api/knowledge/bases/${encodeURIComponent(base.id)}` : "/api/knowledge/bases", base ? "PATCH" : "POST", {
                name: form.name.trim(),
                description: form.description.trim(),
              }).then(async (done) => {
                if (!done) return
                await refetch()
                dialog.close()
              })
            }}
          >
            <label class="package-field">
              {language.t("account.knowledge.name")}
              <TextInput autocomplete="off" value={form.name} onInput={(event) => setForm("name", event.currentTarget.value)} />
            </label>
            <label class="package-field">
              {language.t("account.knowledge.description")}
              <textarea rows={3} value={form.description} onInput={(event) => setForm("description", event.currentTarget.value)} />
              <span class="text-11-regular text-v2-text-text-muted">{language.t("account.knowledge.descriptionHint")}</span>
            </label>
            <div class="package-actions">
              <Button type="button" variant="ghost" onClick={() => dialog.close()}>
                {language.t("account.admin.cancel")}
              </Button>
              <Button type="submit" variant="contrast" disabled={state.pending}>
                {language.t("account.packages.save")}
              </Button>
            </div>
          </form>
        </DialogBody>
      </Dialog>
    ))
  }

  const openEntryForm = (base: string, entry?: AccountKnowledgeEntry) => {
    const [form, setForm] = createStore({
      title: entry?.title ?? "",
      content: entry?.content ?? "",
      summary: entry?.summary ?? "",
      aliases: (entry?.aliases ?? []).join("\n"),
      questions: (entry?.questions ?? []).join("\n"),
      draft: entry ? entry.status === "draft" : false,
    })
    void dialog.show(() => (
      <Dialog fit>
        <DialogHeader>
          <DialogTitleGroup title={language.t(entry ? "account.knowledge.entry.edit" : "account.knowledge.entry.add")} />
        </DialogHeader>
        <DialogBody>
          <form
            data-component="package-upload"
            onSubmit={(event) => {
              event.preventDefault()
              if (!form.title.trim() || !form.content.trim())
                return showToast({ variant: "error", title: language.t("account.knowledge.missing.entry") })
              const body = {
                title: form.title.trim(),
                content: form.content,
                summary: form.summary.trim(),
                aliases: lines(form.aliases),
                questions: lines(form.questions),
                status: form.draft ? "draft" : "published",
              }
              void (
                entry
                  ? call(`/api/knowledge/entries/${encodeURIComponent(entry.id)}`, "PATCH", body)
                  : call(`/api/knowledge/bases/${encodeURIComponent(base)}/entries`, "POST", { entries: [body] })
              ).then(async (done) => {
                if (!done) return
                await Promise.all([refetchEntries(), refetch()])
                dialog.close()
              })
            }}
          >
            <label class="package-field">
              {language.t("account.knowledge.entry.title")}
              <TextInput autocomplete="off" value={form.title} onInput={(event) => setForm("title", event.currentTarget.value)} />
            </label>
            <label class="package-field">
              {language.t("account.knowledge.entry.content")}
              <textarea rows={8} value={form.content} onInput={(event) => setForm("content", event.currentTarget.value)} />
            </label>
            <label class="package-field">
              {language.t("account.knowledge.entry.summary")}
              <textarea rows={2} value={form.summary} onInput={(event) => setForm("summary", event.currentTarget.value)} />
            </label>
            <label class="package-field">
              {language.t("account.knowledge.entry.aliases")}
              <textarea rows={2} value={form.aliases} onInput={(event) => setForm("aliases", event.currentTarget.value)} />
              <span class="text-11-regular text-v2-text-text-muted">{language.t("account.knowledge.entry.aliasesHint")}</span>
            </label>
            <label class="package-field">
              {language.t("account.knowledge.entry.questions")}
              <textarea rows={3} value={form.questions} onInput={(event) => setForm("questions", event.currentTarget.value)} />
              <span class="text-11-regular text-v2-text-text-muted">{language.t("account.knowledge.entry.questionsHint")}</span>
            </label>
            <label class="package-trust">
              <input type="checkbox" checked={form.draft} onChange={(event) => setForm("draft", event.currentTarget.checked)} />
              {language.t("account.knowledge.entry.draft")}
            </label>
            <div class="package-actions">
              <Button type="button" variant="ghost" onClick={() => dialog.close()}>
                {language.t("account.admin.cancel")}
              </Button>
              <Button type="submit" variant="contrast" disabled={state.pending}>
                {language.t("account.packages.save")}
              </Button>
            </div>
          </form>
        </DialogBody>
      </Dialog>
    ))
  }

  // Follows a conversion until it finishes, then shows what it produced.
  // One import is followed at a time; the timer stops when the page closes or the job can no longer be read.
  let watching: ReturnType<typeof setInterval> | undefined
  const stopWatching = () => {
    if (watching !== undefined) clearInterval(watching)
    watching = undefined
  }
  onCleanup(stopWatching)
  const watch = (jobID: string) => {
    stopWatching()
    let misses = 0
    const timer = setInterval(async () => {
      const job = await request<{ status: string; done: number; total: number; error: string }>(`/api/knowledge/jobs/${encodeURIComponent(jobID)}`).catch(() => undefined)
      if (timer !== watching) return
      if (!job) {
        misses++
        if (misses >= 20) stopWatching()
        return
      }
      misses = 0
      setState("job", { id: jobID, ...job })
      if (job.status === "running") return
      stopWatching()
      await Promise.all([refetchEntries(), refetch()])
    }, 1500)
    watching = timer
  }

  const openImport = (base: string) => {
    const [form, setForm] = createStore({ name: "", markdown: "" })
    void dialog.show(() => (
      <Dialog fit>
        <DialogHeader>
          <DialogTitleGroup title={language.t("account.knowledge.import.title")} />
        </DialogHeader>
        <DialogBody>
          <form
            data-component="package-upload"
            onSubmit={(event) => {
              event.preventDefault()
              if (!form.markdown.trim()) return showToast({ variant: "error", title: language.t("account.knowledge.import.missing") })
              void call<{ job: string; total: number; skipped: number }>(`/api/knowledge/bases/${encodeURIComponent(base)}/import`, "POST", {
                markdown: form.markdown,
                name: form.name || undefined,
              }).then((done) => {
                if (!done) return
                dialog.close()
                setState("job", { id: done.value.job, status: done.value.total === 0 ? "done" : "running", done: 0, total: done.value.total, error: "" })
                if (done.value.total > 0) watch(done.value.job)
                else showToast({ variant: "success", title: language.t("account.knowledge.import.nothingNew") })
              })
            }}
          >
            <p class="text-13-regular text-v2-text-text-muted">{language.t("account.knowledge.import.hint")}</p>
            <label class="package-field">
              {language.t("account.knowledge.import.file")}
              <input
                type="file"
                accept=".md,.markdown,.txt,text/markdown,text/plain"
                onChange={(event) => {
                  const file = event.currentTarget.files?.[0]
                  if (!file) return
                  setForm("name", file.name)
                  void file.text().then((text) => setForm("markdown", text))
                }}
              />
            </label>
            <label class="package-field">
              {language.t("account.knowledge.import.paste")}
              <textarea rows={8} value={form.markdown} onInput={(event) => setForm("markdown", event.currentTarget.value)} />
            </label>
            <div class="package-actions">
              <Button type="button" variant="ghost" onClick={() => dialog.close()}>
                {language.t("account.admin.cancel")}
              </Button>
              <Button type="submit" variant="contrast" disabled={state.pending}>
                {language.t("account.knowledge.import.start")}
              </Button>
            </div>
          </form>
        </DialogBody>
      </Dialog>
    ))
  }

  const publish = async (base: string) => {
    const done = await call<{ changed: number }>(`/api/knowledge/bases/${encodeURIComponent(base)}/status`, "POST", { status: "published" })
    if (!done) return
    await Promise.all([refetchEntries(), refetch()])
    showToast({ variant: "success", title: language.plural("account.knowledge.published", done.value.changed) })
  }

  const probe = async (base: string) => {
    if (!state.probe.trim()) return
    const done = await call<AccountKnowledgeSearch>("/api/knowledge/search", "POST", { query: state.probe.trim(), bases: [base], topK: 10 })
    if (done) setState("result", done.value)
  }

  return (
    <Show when={account}>
      <div class="settings-section" data-component="knowledge">
        <div class="flex items-start justify-between gap-4">
          <div class="flex flex-col gap-1">
            <span class="settings-extension-heading text-13-medium">{language.t("account.knowledge.title")}</span>
            <span class="text-13-regular text-v2-text-text-muted">{language.t("account.knowledge.summary")}</span>
          </div>
          <Show when={admin()}>
            <Button variant="contrast" icon="plus" class="shrink-0" onClick={() => openBaseForm()}>
              {language.t("account.knowledge.add")}
            </Button>
          </Show>
        </div>
        <SettingsList variant="catalog">
          <Show
            when={(bases.latest ?? []).length > 0}
            fallback={<div class="settings-extension-row text-v2-text-text-muted">{language.t("account.knowledge.empty")}</div>}
          >
            <For each={bases.latest ?? []}>
              {(base) => (
                <div class="settings-extension-row flex-wrap">
                  <div class="settings-extension-lead">
                    <Icon name="folder" class="text-v2-icon-icon-muted shrink-0" />
                    <div class="flex min-w-0 flex-col">
                      <span class="settings-extension-name truncate">{base.name}</span>
                      <Show when={base.description}>
                        <span class="truncate text-11-regular text-v2-text-text-muted">{base.description}</span>
                      </Show>
                      <span class="truncate text-11-regular text-v2-text-text-muted">
                        {language.plural("account.knowledge.entries", base.entries)}
                        <Show when={admin() && base.drafts > 0}>
                          {" · "}
                          {language.plural("account.knowledge.drafts", base.drafts)}
                        </Show>
                        <Show when={admin()}>
                          {" · "}
                          {base.organizations.length > 0
                            ? base.organizations.map(nameOf).join(", ")
                            : language.t("account.packages.noOrganizations")}
                        </Show>
                      </span>
                    </div>
                  </div>
                  <div class="flex shrink-0 items-center gap-2">
                    <Button variant="ghost" onClick={() => setState({ open: state.open === base.id ? "" : base.id, panel: "entries", query: "", result: undefined })}>
                      {language.t(state.open === base.id ? "account.knowledge.close" : "account.knowledge.open")}
                    </Button>
                    <Show when={admin()}>
                      <Button variant="ghost" onClick={() => openBaseForm(base)}>
                        {language.t("account.knowledge.rename")}
                      </Button>
                      <Button
                        variant="ghost"
                        onClick={() => (state.editing === base.id ? setState("editing", "") : setState({ editing: base.id, draft: [...base.organizations] }))}
                      >
                        {language.t("account.packages.scope")}
                      </Button>
                      <Show
                        when={state.deleting === base.id}
                        fallback={
                          <Button variant="ghost" onClick={() => setState("deleting", base.id)}>
                            {language.t("account.packages.delete")}
                          </Button>
                        }
                      >
                        <Button
                          variant="ghost-danger"
                          disabled={state.pending}
                          onClick={() =>
                            void call(`/api/knowledge/bases/${encodeURIComponent(base.id)}`, "DELETE").then(async () => {
                              setState({ deleting: "", open: state.open === base.id ? "" : state.open })
                              await refetch()
                            })
                          }
                        >
                          {language.t("account.admin.confirmRemove")}
                        </Button>
                        <Button variant="ghost" onClick={() => setState("deleting", "")}>
                          {language.t("account.admin.cancel")}
                        </Button>
                      </Show>
                    </Show>
                  </div>
                  <Show when={admin() && state.editing === base.id}>
                    <div class="flex w-full flex-wrap items-center gap-3 pt-2">
                      <OrganizationPicker
                        organizations={organizations.latest ?? []}
                        selected={state.draft}
                        onChange={(next) => setState("draft", next)}
                      />
                      <Button
                        variant="contrast"
                        disabled={state.pending}
                        onClick={() =>
                          void call(`/api/knowledge/bases/${encodeURIComponent(base.id)}/grants`, "PUT", { organizations: state.draft }).then(async (done) => {
                            if (!done) return
                            setState("editing", "")
                            await refetch()
                          })
                        }
                      >
                        {language.t("account.packages.save")}
                      </Button>
                    </div>
                  </Show>
                  <Show when={state.open === base.id}>
                    <div class="flex w-full flex-col gap-3 pt-3">
                      <div class="flex items-center gap-2">
                        <For each={(admin() ? ["entries", "settings", "test"] : ["entries", "test"]) as Panel[]}>
                          {(panel) => (
                            <Button variant={state.panel === panel ? "contrast" : "ghost"} onClick={() => setState("panel", panel)}>
                              {language.t(`account.knowledge.panel.${panel}`)}
                            </Button>
                          )}
                        </For>
                      </div>
                      <Show when={state.panel === "entries"}>
                        <div class="flex items-center gap-2">
                          <TextInput
                            autocomplete="off"
                            placeholder={language.t("account.knowledge.entry.search")}
                            value={state.query}
                            onInput={(event) => setState("query", event.currentTarget.value)}
                          />
                          <Show when={admin()}>
                            <Button variant="ghost" class="shrink-0" onClick={() => openImport(base.id)}>
                              {language.t("account.knowledge.import.title")}
                            </Button>
                            <Button variant="contrast" icon="plus" class="shrink-0" onClick={() => openEntryForm(base.id)}>
                              {language.t("account.knowledge.entry.add")}
                            </Button>
                          </Show>
                        </div>
                        <Show when={admin() && state.job}>
                          {(job) => (
                            <span class="text-13-regular text-v2-text-text-muted">
                              {job().status === "running"
                                ? language.t("account.knowledge.import.running", { done: job().done, total: job().total })
                                : job().status === "failed"
                                  ? language.t("account.knowledge.import.failed", { error: job().error })
                                  : job().error || language.t("account.knowledge.import.done", { total: job().total })}
                            </span>
                          )}
                        </Show>
                        <Show when={admin() && base.drafts > 0}>
                          <div class="flex items-center gap-2">
                            <span class="text-13-regular text-v2-text-text-muted">{language.plural("account.knowledge.drafts", base.drafts)}</span>
                            <Button variant="contrast" disabled={state.pending} onClick={() => void publish(base.id)}>
                              {language.t("account.knowledge.publish")}
                            </Button>
                          </div>
                        </Show>
                        <Show
                          when={(entries.latest ?? []).length > 0}
                          fallback={<span class="text-13-regular text-v2-text-text-muted">{language.t("account.knowledge.entry.empty")}</span>}
                        >
                          <For each={entries.latest ?? []}>
                            {(entry) => (
                              <div class="flex items-start justify-between gap-3">
                                <div class="flex min-w-0 flex-col">
                                  <span class="truncate text-13-medium">
                                    {entry.title}
                                    <Show when={entry.status === "draft"}>
                                      <span class="text-11-regular text-v2-text-text-muted"> · {language.t("account.knowledge.entry.draftLabel")}</span>
                                    </Show>
                                  </span>
                                  <span class="line-clamp-2 text-11-regular text-v2-text-text-muted">{entry.summary || entry.content}</span>
                                </div>
                                <Show when={admin()}>
                                  <div class="flex shrink-0 items-center gap-2">
                                    <Button variant="ghost" onClick={() => openEntryForm(base.id, entry)}>
                                      {language.t("account.knowledge.entry.edit")}
                                    </Button>
                                    <Button
                                      variant="ghost-danger"
                                      disabled={state.pending}
                                      onClick={() =>
                                        void call(`/api/knowledge/entries/${encodeURIComponent(entry.id)}`, "DELETE").then(async () => {
                                          await Promise.all([refetchEntries(), refetch()])
                                        })
                                      }
                                    >
                                      {language.t("account.packages.delete")}
                                    </Button>
                                  </div>
                                </Show>
                              </div>
                            )}
                          </For>
                        </Show>
                      </Show>
                      <Show when={state.panel === "settings" && admin()}>
                        <KnowledgeSettings base={base.id} request={request} />
                      </Show>
                      <Show when={state.panel === "test"}>
                        <form
                          class="flex items-center gap-2"
                          onSubmit={(event) => {
                            event.preventDefault()
                            void probe(base.id)
                          }}
                        >
                          <TextInput
                            autocomplete="off"
                            placeholder={language.t("account.knowledge.test.placeholder")}
                            value={state.probe}
                            onInput={(event) => setState("probe", event.currentTarget.value)}
                          />
                          <Button type="submit" variant="contrast" class="shrink-0" disabled={state.pending}>
                            {language.t("account.knowledge.test.run")}
                          </Button>
                        </form>
                        <Show when={state.result}>
                          {(result) => (
                            <div class="flex flex-col gap-2">
                              <span class="text-11-regular text-v2-text-text-muted">
                                {language.t("account.knowledge.test.summary", { count: result().hits.length, ms: result().ms })}
                                <Show when={result().degraded.length > 0}> · {language.t("account.knowledge.test.degraded")}</Show>
                              </span>
                              <For each={result().hits}>
                                {(hit) => (
                                  <div class="flex flex-col">
                                    <span class="text-13-medium">
                                      {hit.title} <span class="text-11-regular text-v2-text-text-muted">{hit.score}</span>
                                    </span>
                                    <span class="text-11-regular text-v2-text-text-muted">
                                      {[
                                        hit.channels.exact ? language.t("account.knowledge.test.exact") : undefined,
                                        hit.channels.keyword ? `${language.t("account.knowledge.test.keyword")} #${hit.channels.keyword}` : undefined,
                                        hit.channels.vector ? `${language.t("account.knowledge.test.vector")} #${hit.channels.vector}` : undefined,
                                      ]
                                        .filter(Boolean)
                                        .join(" · ")}
                                    </span>
                                    <span class="line-clamp-3 text-11-regular">{hit.snippet}</span>
                                  </div>
                                )}
                              </For>
                            </div>
                          )}
                        </Show>
                      </Show>
                    </div>
                  </Show>
                </div>
              )}
            </For>
          </Show>
        </SettingsList>
        <Show when={admin()}>
          <details class="knowledge-platform">
            <summary class="text-13-medium">{language.t("account.knowledge.platform")}</summary>
            <KnowledgeSettings request={request} />
          </details>
        </Show>
      </div>
    </Show>
  )
}

type Settings = {
  readonly vector: {
    readonly enabled: boolean
    readonly model: string
    readonly queryPrefix: string
    readonly documentPrefix: string
    readonly store: { readonly type: string; readonly url: string; readonly collectionPrefix: string; readonly hasSecret: boolean }
    readonly queryTimeoutMs: number
    readonly storeTimeoutMs: number
  }
  readonly search: {
    readonly topK: number
    readonly snippetChars: number
    readonly weights: { readonly title: number; readonly aliases: number; readonly questions: number; readonly content: number }
    readonly vectorWeight: number
    readonly rrfK: number
    readonly minScore: number
  }
  readonly enhance: { readonly expand: boolean; readonly rerank: boolean; readonly cacheSeconds: number }
  readonly import: {
    readonly model: string
    readonly chunkChars: number
    readonly overlap: number
    readonly concurrency: number
    readonly aliases: boolean
    readonly questions: boolean
    readonly summary: boolean
    readonly review: boolean
  }
  readonly terms: ReadonlyArray<string>
}

type Field = { readonly path: string; readonly kind: "text" | "number" | "switch" | "choice" }

const CUSTOM = "\u0000custom"
const INSTRUCT = "Instruct: Given a web search query, retrieve relevant passages that answer the query\nQuery: "
const BGE_ZH = "为这个句子生成表示以用于检索相关文章："

/** The prefixes an embedding model family was trained with, guessed from its ID. */
const prefixesFor = (model: string) => {
  const id = model.toLowerCase()
  if (id.includes("nomic")) return { query: "search_query: ", document: "search_document: " }
  if (id.includes("qwen3") || (id.includes("e5") && id.includes("instruct"))) return { query: INSTRUCT, document: "" }
  if (/e5|-e5-/.test(id)) return { query: "query: ", document: "passage: " }
  return { query: "", document: "" }
}

/** Preset choices per free-text field; the label names the model family a prefix belongs to. */
type Choice = { readonly value: string; readonly label?: string; readonly name?: string }

const presets: Record<string, ReadonlyArray<Choice>> = {
  "vector.queryPrefix": [
    { value: "" },
    { value: "query: ", label: "E5" },
    { value: "search_query: ", label: "Nomic" },
    { value: BGE_ZH, label: "BGE (zh)" },
    { value: "Represent this sentence for searching relevant passages: ", label: "BGE (en)" },
    { value: INSTRUCT, label: "Qwen3 / E5 instruct" },
  ],
  "vector.documentPrefix": [
    { value: "" },
    { value: "passage: ", label: "E5" },
    { value: "search_document: ", label: "Nomic" },
  ],
}

const text = (path: string): Field => ({ path, kind: "text" })
const choice = (path: string): Field => ({ path, kind: "choice" })
const number = (path: string): Field => ({ path, kind: "number" })
const toggle = (path: string): Field => ({ path, kind: "switch" })

// enhance.* is left out: the service accepts it but does not act on it yet.
const groups = [
  {
    id: "vector",
    fields: [toggle("vector.enabled"), choice("vector.model"), choice("vector.queryPrefix"), choice("vector.documentPrefix"), number("vector.queryTimeoutMs")],
  },
  {
    id: "search",
    fields: [
      number("search.topK"),
      number("search.snippetChars"),
      number("search.minScore"),
      number("search.vectorWeight"),
      number("search.rrfK"),
      number("search.weights.title"),
      number("search.weights.aliases"),
      number("search.weights.questions"),
      number("search.weights.content"),
    ],
  },
  {
    id: "import",
    fields: [
      choice("import.model"),
      number("import.chunkChars"),
      number("import.overlap"),
      number("import.concurrency"),
      toggle("import.aliases"),
      toggle("import.questions"),
      toggle("import.summary"),
      toggle("import.review"),
    ],
  },
] as const

const numbers = groups.flatMap((group) => group.fields.filter((field) => field.kind === "number").map((field) => field.path)).concat("vector.storeTimeoutMs")

const read = (value: unknown, path: string) =>
  path.split(".").reduce<unknown>((current, key) => (typeof current === "object" && current !== null ? (current as Record<string, unknown>)[key] : undefined), value)

/** A nested object holding only `value` at `path`, which is how the service takes a change. */
const nest = (path: string, value: unknown): Record<string, unknown> =>
  path
    .split(".")
    .reverse()
    .reduce<unknown>((inner, key) => ({ [key]: inner }), value) as Record<string, unknown>

const merge = (a: Record<string, unknown>, b: Record<string, unknown>): Record<string, unknown> =>
  Object.fromEntries(
    [...new Set([...Object.keys(a), ...Object.keys(b)])].map((key) => {
      const left = a[key]
      const right = b[key]
      return [
        key,
        typeof left === "object" && left !== null && typeof right === "object" && right !== null
          ? merge(left as Record<string, unknown>, right as Record<string, unknown>)
          : (right ?? left),
      ]
    }),
  )

/** The search and import settings of one base, or the platform defaults when no base is given. */
function KnowledgeSettings(props: { base?: string; request: <T>(path: string, method?: string, body?: unknown) => Promise<T> }) {
  const language = useLanguage()
  const path = () => (props.base ? `/api/knowledge/bases/${encodeURIComponent(props.base)}/settings` : "/api/knowledge/settings")
  const [state, setState] = createStore({
    pending: false,
    edits: {} as Record<string, string | boolean>,
    custom: {} as Record<string, boolean>,
    secret: "",
    store: "",
    terms: undefined as string | undefined,
    tested: "",
  })
  const [loaded, { refetch }] = createResource(
    () => props.base ?? "platform",
    () => props.request<{ effective: Settings } | Settings>(path()).then((value) => ("effective" in value ? value.effective : value)),
  )
  const current = () => loaded.latest
  const value = (field: string) => {
    const edited = state.edits[field]
    if (edited !== undefined) return edited
    return current() ? (read(current(), field) as string | number | boolean) : ""
  }

  const save = async () => {
    const base = current()
    if (!base) return
    const patch = Object.entries(state.edits).reduce<Record<string, unknown>>(
      (all, [field, edited]) =>
        merge(all, nest(field, typeof edited === "string" && numbers.includes(field) ? Number(edited) : edited)),
      {},
    )
    const withStore = state.store ? merge(patch, nest("vector.store.type", state.store)) : patch
    const withSecret = state.secret ? merge(withStore, nest("vector.store.secret", state.secret)) : withStore
    const withTerms = state.terms === undefined ? withSecret : merge(withSecret, { terms: state.terms.split("\n").map((line) => line.trim()).filter(Boolean) })
    setState("pending", true)
    try {
      await props.request(path(), "PATCH", withTerms)
      setState({ edits: {}, custom: {}, secret: "", store: "", terms: undefined })
      await refetch()
      showToast({ variant: "success", title: language.t("account.knowledge.settings.saved") })
    } catch (error) {
      showToast({
        variant: "error",
        title: language.t("account.knowledge.failed"),
        description: error instanceof AccountError ? error.message : undefined,
      })
    } finally {
      setState("pending", false)
    }
  }

  const test = async () => {
    setState("pending", true)
    try {
      const result = await props.request<{ ok: boolean; ms: number }>("/api/knowledge/vector-store/test", "POST", {
        vector: { store: { type: state.store || current()?.vector.store.type, url: String(value("vector.store.url")), ...(state.secret ? { secret: state.secret } : {}) } },
      })
      setState("tested", language.t(result.ok ? "account.knowledge.settings.reachable" : "account.knowledge.settings.unreachable", { ms: result.ms }))
    } catch (error) {
      setState("tested", error instanceof AccountError ? error.message : language.t("account.knowledge.failed"))
    } finally {
      setState("pending", false)
    }
  }

  const dirty = () => Object.keys(state.edits).length > 0 || state.store !== "" || state.secret !== "" || state.terms !== undefined
  const store = () => state.store || current()?.vector.store.type || "builtin"
  const [catalog] = createResource(() => props.request<{ chat: Choice[]; embedding: Choice[] }>("/api/knowledge/models"))
  // Only models set up under Settings > Models are offered; a saved value outside them shows as custom.
  const options = (field: string): ReadonlyArray<Choice> => {
    if (field === "import.model") return catalog.latest?.chat ?? []
    if (field === "vector.model") return catalog.latest?.embedding ?? []
    return presets[field] ?? []
  }
  const custom = (field: string) =>
    state.custom[field] || (!(field.endsWith(".model") && value(field) === "") && !options(field).some((item) => item.value === value(field)))
  const pick = (field: string, picked: string) => {
    if (picked === CUSTOM) return setState("custom", field, true)
    setState("custom", field, false)
    setState("edits", field, picked)
    // A preset model brings the prefixes it was trained with; they can still be changed afterwards.
    if (field !== "vector.model") return
    const model = prefixesFor(picked)
    setState("custom", { "vector.queryPrefix": false, "vector.documentPrefix": false })
    setState("edits", { "vector.queryPrefix": model.query, "vector.documentPrefix": model.document })
  }
  const label = (item: Choice) => {
    if (item.name) return item.name
    if (item.value === "") return language.t("account.knowledge.settings.none")
    const shown = item.value.length > 40 ? `${item.value.slice(0, 40)}…` : item.value
    return item.label ? `${item.label} · ${shown}` : shown
  }
  const select = (field: Field) => (
    <label class="knowledge-field">
      {language.t(`account.knowledge.settings.${field.path}`)}
      <select value={custom(field.path) ? CUSTOM : String(value(field.path))} disabled={field.path.endsWith(".model") && catalog.loading && !catalog.latest} onChange={(event) => pick(field.path, event.currentTarget.value)}>
        <Show when={field.path.endsWith(".model") && value(field.path) === ""}>
          <option value="">{language.t("account.knowledge.settings.choose")}</option>
        </Show>
        <For each={options(field.path)}>{(item) => <option value={item.value}>{label(item)}</option>}</For>
        <option value={CUSTOM}>{language.t("account.knowledge.settings.custom")}</option>
      </select>
      <Show when={custom(field.path)}>
        <TextInput
          autocomplete="off"
          placeholder={language.t(`account.knowledge.settings.${field.path}.placeholder`)}
          value={String(value(field.path))}
          onInput={(event) => setState("edits", field.path, event.currentTarget.value)}
        />
      </Show>
    </label>
  )
  const input = (field: Field) => (
    <Show when={field.kind !== "choice"} fallback={select(field)}>
    <Show
      when={field.kind !== "switch"}
      fallback={
        <label class="knowledge-switch">
          <input type="checkbox" checked={Boolean(value(field.path))} onChange={(event) => setState("edits", field.path, event.currentTarget.checked)} />
          {language.t(`account.knowledge.settings.${field.path}`)}
        </label>
      }
    >
      <label class="knowledge-field">
        {language.t(`account.knowledge.settings.${field.path}`)}
        <TextInput
          autocomplete="off"
          type={field.kind === "number" ? "number" : "text"}
          value={String(value(field.path))}
          onInput={(event) => setState("edits", field.path, event.currentTarget.value)}
        />
      </label>
    </Show>
    </Show>
  )

  return (
    <Show when={current()}>
      {(settings) => (
        <div data-component="knowledge-settings">
          <For each={groups}>
            {(group) => (
              <section class="knowledge-group">
                <header>
                  <span class="text-13-medium">{language.t(`account.knowledge.settings.group.${group.id}`)}</span>
                  <span class="text-12-regular text-v2-text-text-muted">{language.t(`account.knowledge.settings.group.${group.id}.hint`)}</span>
                </header>
                <div class="knowledge-switches">
                  <For each={group.fields.filter((field) => field.kind === "switch")}>{input}</For>
                </div>
                <div class="knowledge-grid">
                  <For each={group.fields.filter((field) => field.kind !== "switch")}>{input}</For>
                </div>
              </section>
            )}
          </For>
          <section class="knowledge-group">
            <header>
              <span class="text-13-medium">{language.t("account.knowledge.settings.group.store")}</span>
              <span class="text-12-regular text-v2-text-text-muted">{language.t("account.knowledge.settings.group.store.hint")}</span>
            </header>
            <div class="knowledge-grid">
              <label class="knowledge-field">
                {language.t("account.knowledge.settings.vector.store.type")}
                <select value={store()} onChange={(event) => setState("store", event.currentTarget.value)}>
                  <option value="builtin">{language.t("account.knowledge.settings.vector.store.builtin")}</option>
                  <option value="pgvector">pgvector</option>
                  <option value="qdrant">Qdrant</option>
                </select>
              </label>
              {input(number("vector.storeTimeoutMs"))}
              <Show when={store() !== "builtin"}>
                {input(text("vector.store.url"))}
                {input(text("vector.store.collectionPrefix"))}
                <label class="knowledge-field">
                  {language.t("account.knowledge.settings.vector.store.secret")}
                  <TextInput
                    autocomplete="off"
                    type="password"
                    placeholder={settings().vector.store.hasSecret ? language.t("account.knowledge.settings.secretSet") : ""}
                    value={state.secret}
                    onInput={(event) => setState("secret", event.currentTarget.value)}
                  />
                </label>
                <div class="knowledge-test">
                  <Button type="button" variant="ghost" disabled={state.pending} onClick={() => void test()}>
                    {language.t("account.knowledge.settings.test")}
                  </Button>
                  <Show when={state.tested}>
                    <span class="text-12-regular text-v2-text-text-muted">{state.tested}</span>
                  </Show>
                </div>
              </Show>
            </div>
          </section>
          <section class="knowledge-group">
            <header>
              <span class="text-13-medium">{language.t("account.knowledge.settings.terms")}</span>
              <span class="text-12-regular text-v2-text-text-muted">{language.t("account.knowledge.settings.termsHint")}</span>
            </header>
            <textarea
              rows={4}
              value={state.terms ?? settings().terms.join("\n")}
              onInput={(event) => setState("terms", event.currentTarget.value)}
            />
          </section>
          <div class="knowledge-actions">
            <Button type="button" variant="ghost" disabled={state.pending || !dirty()} onClick={() => setState({ edits: {}, custom: {}, secret: "", store: "", terms: undefined, tested: "" })}>
              {language.t("account.knowledge.settings.reset")}
            </Button>
            <Button type="button" variant="contrast" disabled={state.pending || !dirty()} onClick={() => void save()}>
              {language.t("account.packages.save")}
            </Button>
          </div>
        </div>
      )}
    </Show>
  )
}
