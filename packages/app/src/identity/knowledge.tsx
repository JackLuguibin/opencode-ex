import { createResource, For, type JSX, onCleanup, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { Badge } from "@opencode/ui/badge"
import { Button } from "@opencode/ui/button"
import { useDialog } from "@opencode/ui/context/dialog"
import { Dialog, DialogBody, DialogHeader, DialogTitleGroup } from "@opencode/ui/dialog"
import { Icon } from "@opencode/ui/icon"
import { IconButton } from "@opencode/ui/icon-button"
import { Menu } from "@opencode/ui/menu"
import { TextInput } from "@opencode/ui/text-input"
import { useLanguage } from "@/runtime/i18n/language"
import { showToast } from "@/shell/notifications/toast"
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
    probe: "",
    result: undefined as AccountKnowledgeSearch | undefined,
    removing: "",
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

  const openPlatform = () =>
    void dialog.show(() => (
      <Dialog size="x-large">
        <DialogHeader>
          <DialogTitleGroup title={language.t("account.knowledge.platform")} />
        </DialogHeader>
        <DialogBody>
          <KnowledgeSettings request={request} layout="dialog" onClose={() => dialog.close()} />
        </DialogBody>
      </Dialog>
    ))

  const openBaseForm = (base?: AccountKnowledgeBase) => {
    const [form, setForm] = createStore({ name: base?.name ?? "", description: base?.description ?? "" })
    const submit = () => {
      if (!form.name.trim()) return showToast({ variant: "error", title: language.t("account.knowledge.missing.name") })
      void call(
        base ? `/api/knowledge/bases/${encodeURIComponent(base.id)}` : "/api/knowledge/bases",
        base ? "PATCH" : "POST",
        { name: form.name.trim(), description: form.description.trim() },
      ).then(async (done) => {
        if (!done) return
        await refetch()
        dialog.close()
      })
    }
    void dialog.show(() => (
      <FormDialog
        title={language.t(base ? "account.knowledge.rename" : "account.knowledge.add")}
        submit={language.t("account.packages.save")}
        pending={state.pending}
        onSubmit={submit}
        onCancel={() => dialog.close()}
      >
        <label class="knowledge-form-field">
          {language.t("account.knowledge.name")}
          <TextInput
            autocomplete="off"
            value={form.name}
            onInput={(event) => setForm("name", event.currentTarget.value)}
          />
        </label>
        <label class="knowledge-form-field">
          {language.t("account.knowledge.description")}
          <textarea
            rows={4}
            value={form.description}
            onInput={(event) => setForm("description", event.currentTarget.value)}
          />
          <span class="knowledge-form-hint">{language.t("account.knowledge.descriptionHint")}</span>
        </label>
      </FormDialog>
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
    const submit = () => {
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
    }
    void dialog.show(() => (
      <FormDialog
        wide
        title={language.t(entry ? "account.knowledge.entry.edit" : "account.knowledge.entry.add")}
        submit={language.t("account.packages.save")}
        pending={state.pending}
        onSubmit={submit}
        onCancel={() => dialog.close()}
        aside={
          <label class="knowledge-switch">
            <input
              type="checkbox"
              checked={form.draft}
              onChange={(event) => setForm("draft", event.currentTarget.checked)}
            />
            {language.t("account.knowledge.entry.draft")}
          </label>
        }
      >
        <label class="knowledge-form-field">
          {language.t("account.knowledge.entry.title")}
          <TextInput
            autocomplete="off"
            value={form.title}
            onInput={(event) => setForm("title", event.currentTarget.value)}
          />
        </label>
        <label class="knowledge-form-field">
          {language.t("account.knowledge.entry.content")}
          <textarea
            class="knowledge-form-content"
            rows={10}
            value={form.content}
            onInput={(event) => setForm("content", event.currentTarget.value)}
          />
          <span class="knowledge-form-hint">{language.t("account.knowledge.entry.contentHint")}</span>
        </label>
        <label class="knowledge-form-field">
          {language.t("account.knowledge.entry.summary")}
          <TextInput
            autocomplete="off"
            value={form.summary}
            onInput={(event) => setForm("summary", event.currentTarget.value)}
          />
        </label>
        <div class="knowledge-form-columns">
          <label class="knowledge-form-field">
            {language.t("account.knowledge.entry.aliases")}
            <textarea
              rows={4}
              value={form.aliases}
              onInput={(event) => setForm("aliases", event.currentTarget.value)}
            />
            <span class="knowledge-form-hint">{language.t("account.knowledge.entry.aliasesHint")}</span>
          </label>
          <label class="knowledge-form-field">
            {language.t("account.knowledge.entry.questions")}
            <textarea
              rows={4}
              value={form.questions}
              onInput={(event) => setForm("questions", event.currentTarget.value)}
            />
            <span class="knowledge-form-hint">{language.t("account.knowledge.entry.questionsHint")}</span>
          </label>
        </div>
      </FormDialog>
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
      const job = await request<{ status: string; done: number; total: number; error: string }>(
        `/api/knowledge/jobs/${encodeURIComponent(jobID)}`,
      ).catch(() => undefined)
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
    const [form, setForm] = createStore({ name: "", size: 0, markdown: "", over: false })
    const pickFile = (file: File | undefined) => {
      if (!file) return
      setForm({ name: file.name, size: file.size })
      void file.text().then((text) => setForm("markdown", text))
    }
    const submit = () => {
      if (!form.markdown.trim())
        return showToast({ variant: "error", title: language.t("account.knowledge.import.missing") })
      void call<{ job: string; total: number; skipped: number }>(
        `/api/knowledge/bases/${encodeURIComponent(base)}/import`,
        "POST",
        { markdown: form.markdown, name: form.name || undefined },
      ).then((done) => {
        if (!done) return
        dialog.close()
        setState("job", {
          id: done.value.job,
          status: done.value.total === 0 ? "done" : "running",
          done: 0,
          total: done.value.total,
          error: "",
        })
        if (done.value.total > 0) watch(done.value.job)
        else showToast({ variant: "success", title: language.t("account.knowledge.import.nothingNew") })
      })
    }
    void dialog.show(() => (
      <FormDialog
        wide
        title={language.t("account.knowledge.import.title")}
        description={language.t("account.knowledge.import.hint")}
        submit={language.t("account.knowledge.import.start")}
        pending={state.pending}
        onSubmit={submit}
        onCancel={() => dialog.close()}
      >
        <label
          class="knowledge-drop"
          data-over={form.over ? "" : undefined}
          onDragOver={(event) => {
            event.preventDefault()
            setForm("over", true)
          }}
          onDragLeave={() => setForm("over", false)}
          onDrop={(event) => {
            event.preventDefault()
            setForm("over", false)
            pickFile(event.dataTransfer?.files[0])
          }}
        >
          <input
            type="file"
            class="sr-only"
            accept=".md,.markdown,.txt,text/markdown,text/plain"
            onChange={(event) => pickFile(event.currentTarget.files?.[0])}
          />
          <Icon name="file-document" class="text-v2-icon-icon-muted" />
          <Show
            when={form.name}
            fallback={<span class="text-13-regular">{language.t("account.knowledge.import.drop")}</span>}
          >
            <span class="text-13-medium">{form.name}</span>
            <span class="knowledge-form-hint">
              {language.t("account.knowledge.import.size", { kb: Math.max(1, Math.round(form.size / 1024)) })}
            </span>
          </Show>
        </label>
        <label class="knowledge-form-field">
          {language.t("account.knowledge.import.paste")}
          <textarea
            class="knowledge-form-content"
            rows={10}
            value={form.markdown}
            onInput={(event) => setForm("markdown", event.currentTarget.value)}
          />
        </label>
      </FormDialog>
    ))
  }

  const publish = async (base: string) => {
    const done = await call<{ changed: number }>(`/api/knowledge/bases/${encodeURIComponent(base)}/status`, "POST", {
      status: "published",
    })
    if (!done) return
    await Promise.all([refetchEntries(), refetch()])
    showToast({ variant: "success", title: language.plural("account.knowledge.published", done.value.changed) })
  }

  const probe = async (base: string) => {
    if (!state.probe.trim()) return
    const done = await call<AccountKnowledgeSearch>("/api/knowledge/search", "POST", {
      query: state.probe.trim(),
      bases: [base],
      topK: 10,
    })
    if (done) setState("result", done.value)
  }

  const removeEntry = (entry: string) =>
    void call(`/api/knowledge/entries/${encodeURIComponent(entry)}`, "DELETE").then(async (done) => {
      setState("removing", "")
      if (done) await Promise.all([refetchEntries(), refetch()])
    })

  const openBase = (base: string) =>
    setState({ open: base, panel: "entries", query: "", result: undefined, removing: "" })

  const [stats] = createResource(
    () => (admin() && state.open ? state.open : undefined),
    (base) =>
      request<{ published: number; drafts: number; vectors: number }>(
        `/api/knowledge/bases/${encodeURIComponent(base)}/stats`,
      ).then(
        (value) => ({ base, ...value }),
        () => undefined,
      ),
  )
  // Only the counts of the base on screen; the previous base's stay hidden while the next ones load.
  const statsOf = (base: string) => (stats.state === "ready" && stats.latest?.base === base ? stats.latest : undefined)

  const openScope = (base: AccountKnowledgeBase) => {
    const [form, setForm] = createStore({ selected: [...base.organizations] })
    void dialog.show(() => (
      <FormDialog
        title={language.t("account.packages.scope")}
        description={base.name}
        submit={language.t("account.packages.save")}
        pending={state.pending}
        onCancel={() => dialog.close()}
        onSubmit={() =>
          void call(`/api/knowledge/bases/${encodeURIComponent(base.id)}/grants`, "PUT", {
            organizations: form.selected,
          }).then(async (done) => {
            if (!done) return
            await refetch()
            dialog.close()
          })
        }
      >
        <OrganizationPicker
          organizations={organizations.latest ?? []}
          selected={form.selected}
          onChange={(next) => setForm("selected", next)}
        />
      </FormDialog>
    ))
  }

  const confirmDelete = (base: AccountKnowledgeBase) =>
    void dialog.show(() => (
      <FormDialog
        title={language.t("account.knowledge.deleteTitle", { name: base.name })}
        submit={language.t("account.admin.confirmRemove")}
        danger
        pending={state.pending}
        onCancel={() => dialog.close()}
        onSubmit={() =>
          void call(`/api/knowledge/bases/${encodeURIComponent(base.id)}`, "DELETE").then(async (done) => {
            if (!done) return
            dialog.close()
            if (state.open === base.id) setState("open", "")
            await refetch()
          })
        }
      >
        <p class="text-13-regular">{language.t("account.knowledge.deleteConfirm")}</p>
      </FormDialog>
    ))

  const baseMenu = (base: AccountKnowledgeBase) => (
    <Show when={admin()}>
      <div class="contents" onClick={(event) => event.stopPropagation()} onKeyDown={(event) => event.stopPropagation()}>
        <Menu placement="bottom-end" gutter={6}>
          <Menu.Trigger
            as={IconButton}
            variant="ghost-muted"
            size="large"
            icon={<Icon name="outline-dots" />}
            aria-label={language.t("account.knowledge.more")}
          />
          <Menu.Portal>
            <Menu.Content>
              <Menu.Item onSelect={() => openBaseForm(base)}>{language.t("account.knowledge.rename")}</Menu.Item>
              <Menu.Item onSelect={() => openScope(base)}>{language.t("account.packages.scope")}</Menu.Item>
              <Menu.Item onSelect={() => confirmDelete(base)}>{language.t("account.packages.delete")}</Menu.Item>
            </Menu.Content>
          </Menu.Portal>
        </Menu>
      </div>
    </Show>
  )

  const opened = () => (bases.latest ?? []).filter((base) => base.id === state.open)

  return (
    <Show when={account}>
      <div class="settings-section" data-component="knowledge">
        <Show
          when={opened().length > 0}
          fallback={
            <>
              <div class="knowledge-head">
                <div class="flex min-w-0 flex-col gap-1">
                  <span class="settings-extension-heading text-13-medium">{language.t("account.knowledge.title")}</span>
                  <span class="text-13-regular text-v2-text-text-muted">{language.t("account.knowledge.summary")}</span>
                </div>
                <Show when={admin()}>
                  <div class="flex shrink-0 items-center gap-2">
                    <Button variant="ghost" icon="settings-gear" onClick={() => openPlatform()}>
                      {language.t("account.knowledge.platform.open")}
                    </Button>
                    <Button variant="contrast" icon="plus" onClick={() => openBaseForm()}>
                      {language.t("account.knowledge.add")}
                    </Button>
                  </div>
                </Show>
              </div>
              <div class="knowledge-cards">
                <For each={bases.latest ?? []}>
                  {(base) => (
                    <div
                      class="knowledge-card"
                      role="button"
                      tabindex="0"
                      onClick={() => openBase(base.id)}
                      onKeyDown={(event) => {
                        if (event.key !== "Enter" && event.key !== " ") return
                        event.preventDefault()
                        openBase(base.id)
                      }}
                    >
                      <div class="knowledge-card-top">
                        <Avatar name={base.name} />
                        {baseMenu(base)}
                      </div>
                      <div class="flex min-w-0 flex-col gap-1">
                        <span class="knowledge-card-name">{base.name}</span>
                        <span class="knowledge-card-description" data-empty={base.description ? undefined : ""}>
                          {base.description || language.t("account.knowledge.noDescription")}
                        </span>
                      </div>
                      <div class="knowledge-card-foot">
                        <span class="knowledge-chip">
                          <Icon name="file-document" />
                          {language.plural("account.knowledge.entries", base.entries)}
                        </span>
                        <Show when={admin() && base.drafts > 0}>
                          <span class="knowledge-chip" data-tone="accent">
                            {language.plural("account.knowledge.drafts", base.drafts)}
                          </span>
                        </Show>
                        <Show when={admin()}>
                          <span class="knowledge-chip" title={base.organizations.map(nameOf).join(", ")}>
                            <Icon name="outline-globe" />
                            {base.organizations.length > 0
                              ? language.plural("account.knowledge.organizations", base.organizations.length)
                              : language.t("account.packages.noOrganizations")}
                          </span>
                        </Show>
                      </div>
                    </div>
                  )}
                </For>
                <Show when={admin()}>
                  <button type="button" class="knowledge-card knowledge-card-new" onClick={() => openBaseForm()}>
                    <span class="knowledge-card-new-icon">
                      <Icon name="plus" />
                    </span>
                    <span class="text-13-medium">{language.t("account.knowledge.add")}</span>
                    <span class="text-12-regular text-v2-text-text-muted">
                      {language.t("account.knowledge.addHint")}
                    </span>
                  </button>
                </Show>
              </div>
              <Show when={!admin() && (bases.latest ?? []).length === 0}>
                <div class="knowledge-empty">
                  <Icon name="folder" class="text-v2-icon-icon-muted" />
                  <span>{language.t("account.knowledge.empty")}</span>
                </div>
              </Show>
            </>
          }
        >
          <For each={opened()}>
            {(base) => (
              <div class="knowledge-detail">
                <button type="button" class="knowledge-back" onClick={() => setState("open", "")}>
                  <Icon name="outline-arrow-left" />
                  {language.t("account.knowledge.back")}
                </button>
                <header class="knowledge-hero">
                  <Avatar name={base.name} large />
                  <div class="flex min-w-0 flex-1 flex-col gap-1">
                    <span class="knowledge-hero-title">{base.name}</span>
                    <span class="text-13-regular text-v2-text-text-muted">
                      {base.description || language.t("account.knowledge.noDescription")}
                    </span>
                  </div>
                  {baseMenu(base)}
                </header>
                <div class="knowledge-stats">
                  <div class="knowledge-stat">
                    <span>{language.t("account.knowledge.stat.entries")}</span>
                    <strong>{base.entries}</strong>
                  </div>
                  <Show when={admin()}>
                    <div class="knowledge-stat">
                      <span>{language.t("account.knowledge.stat.drafts")}</span>
                      <strong>{base.drafts}</strong>
                    </div>
                    <div class="knowledge-stat">
                      <span>{language.t("account.knowledge.stat.vectors")}</span>
                      <strong>{statsOf(base.id)?.vectors ?? "–"}</strong>
                    </div>
                    <div class="knowledge-stat">
                      <span>{language.t("account.knowledge.stat.organizations")}</span>
                      <strong>{base.organizations.length}</strong>
                    </div>
                  </Show>
                </div>
                <div class="knowledge-tabs" role="tablist">
                  <For each={(admin() ? ["entries", "settings", "test"] : ["entries", "test"]) as Panel[]}>
                    {(panel) => (
                      <button
                        type="button"
                        role="tab"
                        aria-selected={state.panel === panel}
                        data-active={state.panel === panel ? "" : undefined}
                        onClick={() => setState("panel", panel)}
                      >
                        {language.t(`account.knowledge.panel.${panel}`)}
                      </button>
                    )}
                  </For>
                </div>
                <div class="knowledge-tab-body">
                  <Show when={state.panel === "entries"}>
                    <div class="knowledge-toolbar">
                      <div class="knowledge-search">
                        <Icon name="magnifying-glass" class="text-v2-icon-icon-muted shrink-0" />
                        <input
                          autocomplete="off"
                          placeholder={language.t("account.knowledge.entry.search")}
                          value={state.query}
                          onInput={(event) => setState("query", event.currentTarget.value)}
                        />
                      </div>
                      <Show when={admin()}>
                        <Button
                          variant="ghost"
                          icon="file-document"
                          class="shrink-0"
                          onClick={() => openImport(base.id)}
                        >
                          {language.t("account.knowledge.import.title")}
                        </Button>
                        <Button variant="contrast" icon="plus" class="shrink-0" onClick={() => openEntryForm(base.id)}>
                          {language.t("account.knowledge.entry.add")}
                        </Button>
                      </Show>
                    </div>
                    <Show when={admin() && state.job}>
                      {(job) => (
                        <div class="knowledge-job" data-status={job().status}>
                          <span>
                            {job().status === "running"
                              ? language.t("account.knowledge.import.running", {
                                  done: job().done,
                                  total: job().total,
                                })
                              : job().status === "failed"
                                ? language.t("account.knowledge.import.failed", { error: job().error })
                                : job().error || language.t("account.knowledge.import.done", { total: job().total })}
                          </span>
                          <Show when={job().status === "running" && job().total > 0}>
                            <div class="knowledge-progress">
                              <div style={{ width: `${Math.round((job().done / job().total) * 100)}%` }} />
                            </div>
                          </Show>
                        </div>
                      )}
                    </Show>
                    <Show when={admin() && base.drafts > 0}>
                      <div class="knowledge-banner">
                        <span>{language.plural("account.knowledge.drafts.waiting", base.drafts)}</span>
                        <Button variant="contrast" disabled={state.pending} onClick={() => void publish(base.id)}>
                          {language.t("account.knowledge.publish")}
                        </Button>
                      </div>
                    </Show>
                    <Show
                      when={(entries.latest ?? []).length > 0}
                      fallback={<div class="knowledge-empty">{language.t("account.knowledge.entry.empty")}</div>}
                    >
                      <div class="knowledge-entries">
                        <For each={entries.latest ?? []}>
                          {(entry) => (
                            <div class="knowledge-entry">
                              <div class="flex min-w-0 flex-1 flex-col gap-0.5">
                                <span class="flex min-w-0 items-center gap-2">
                                  <span class="truncate text-13-medium">{entry.title}</span>
                                  <Show when={entry.status === "draft"}>
                                    <Badge variant="accent">{language.t("account.knowledge.entry.draftLabel")}</Badge>
                                  </Show>
                                </span>
                                <span class="line-clamp-2 text-12-regular text-v2-text-text-muted">
                                  {entry.summary || entry.content}
                                </span>
                              </div>
                              <Show when={admin()}>
                                <div class="knowledge-entry-actions">
                                  <Show
                                    when={state.removing === entry.id}
                                    fallback={
                                      <>
                                        <Button variant="ghost" onClick={() => openEntryForm(base.id, entry)}>
                                          {language.t("account.knowledge.rename")}
                                        </Button>
                                        <IconButton
                                          variant="ghost-muted"
                                          icon={<Icon name="outline-trash" />}
                                          aria-label={language.t("account.packages.delete")}
                                          onClick={() => setState("removing", entry.id)}
                                        />
                                      </>
                                    }
                                  >
                                    <Button
                                      variant="ghost-danger"
                                      disabled={state.pending}
                                      onClick={() => removeEntry(entry.id)}
                                    >
                                      {language.t("account.admin.confirmRemove")}
                                    </Button>
                                    <Button variant="ghost" onClick={() => setState("removing", "")}>
                                      {language.t("account.admin.cancel")}
                                    </Button>
                                  </Show>
                                </div>
                              </Show>
                            </div>
                          )}
                        </For>
                      </div>
                    </Show>
                  </Show>
                  <Show when={state.panel === "settings" && admin()}>
                    <KnowledgeSettings base={base.id} request={request} />
                  </Show>
                  <Show when={state.panel === "test"}>
                    <form
                      class="knowledge-toolbar"
                      onSubmit={(event) => {
                        event.preventDefault()
                        void probe(base.id)
                      }}
                    >
                      <div class="knowledge-search">
                        <Icon name="magnifying-glass" class="text-v2-icon-icon-muted shrink-0" />
                        <input
                          autocomplete="off"
                          placeholder={language.t("account.knowledge.test.placeholder")}
                          value={state.probe}
                          onInput={(event) => setState("probe", event.currentTarget.value)}
                        />
                      </div>
                      <Button type="submit" variant="contrast" class="shrink-0" disabled={state.pending}>
                        {language.t("account.knowledge.test.run")}
                      </Button>
                    </form>
                    <Show when={state.result}>
                      {(result) => (
                        <div class="flex flex-col gap-2">
                          <span class="text-12-regular text-v2-text-text-muted">
                            {language.t("account.knowledge.test.summary", {
                              count: result().hits.length,
                              ms: result().ms,
                            })}
                          </span>
                          <Show when={result().degraded.length > 0}>
                            <div class="knowledge-banner" data-tone="warning">
                              {language.t("account.knowledge.test.degraded")}
                            </div>
                          </Show>
                          <For each={result().hits}>
                            {(hit, index) => (
                              <div class="knowledge-hit">
                                <span class="knowledge-hit-rank">{index() + 1}</span>
                                <div class="flex min-w-0 flex-1 flex-col gap-1">
                                  <span class="flex min-w-0 items-center gap-2">
                                    <span class="truncate text-13-medium">{hit.title}</span>
                                    <span class="text-12-regular text-v2-text-text-muted">{hit.score}</span>
                                  </span>
                                  <span class="flex flex-wrap gap-1">
                                    <Show when={hit.channels.exact}>
                                      <Badge>{language.t("account.knowledge.test.exact")}</Badge>
                                    </Show>
                                    <Show when={hit.channels.keyword}>
                                      <Badge>{`${language.t("account.knowledge.test.keyword")} #${hit.channels.keyword}`}</Badge>
                                    </Show>
                                    <Show when={hit.channels.vector}>
                                      <Badge>{`${language.t("account.knowledge.test.vector")} #${hit.channels.vector}`}</Badge>
                                    </Show>
                                  </span>
                                  <span class="line-clamp-3 text-12-regular text-v2-text-text-muted">
                                    {hit.snippet}
                                  </span>
                                </div>
                              </div>
                            )}
                          </For>
                        </div>
                      )}
                    </Show>
                  </Show>
                </div>
              </div>
            )}
          </For>
        </Show>
      </div>
    </Show>
  )
}

/** A tile with the first letter of a base's name, tinted by the name so bases are told apart at a glance. */
function Avatar(props: { name: string; large?: boolean }) {
  const hue = () => [...props.name].reduce((sum, char) => (sum * 31 + char.codePointAt(0)!) % 360, 7)
  return (
    <span class="knowledge-avatar" data-large={props.large ? "" : undefined} style={{ "--kb-hue": String(hue()) }}>
      {[...props.name.trim()][0]?.toUpperCase() ?? "?"}
    </span>
  )
}

/**
 * A form in a dialog that never grows past the window: the header and the actions stay put and only the fields scroll.
 * Ctrl+Enter (Cmd+Enter) submits from any field.
 */
function FormDialog(props: {
  title: string
  description?: string
  submit: string
  pending: boolean
  wide?: boolean
  danger?: boolean
  aside?: JSX.Element
  onSubmit: () => void
  onCancel: () => void
  children: JSX.Element
}) {
  const language = useLanguage()
  return (
    <Dialog size={props.wide ? "large" : "normal"} fit containerClass="knowledge-dialog">
      <DialogHeader>
        <DialogTitleGroup title={props.title} description={props.description} />
      </DialogHeader>
      <form
        class="knowledge-form"
        onSubmit={(event) => {
          event.preventDefault()
          props.onSubmit()
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
            event.preventDefault()
            props.onSubmit()
          }
        }}
      >
        <div class="knowledge-form-body" data-scrollable>
          {props.children}
        </div>
        <div class="knowledge-form-footer">
          <div class="knowledge-form-aside">{props.aside}</div>
          <span class="knowledge-form-hint">{language.t("account.knowledge.form.shortcut")}</span>
          <Button type="button" variant="ghost" onClick={props.onCancel}>
            {language.t("account.admin.cancel")}
          </Button>
          <Button type="submit" variant={props.danger ? "ghost-danger" : "contrast"} disabled={props.pending}>
            {props.submit}
          </Button>
        </div>
      </form>
    </Dialog>
  )
}

type Settings = {
  readonly vector: {
    readonly enabled: boolean
    readonly model: string
    readonly queryPrefix: string
    readonly documentPrefix: string
    readonly store: {
      readonly type: string
      readonly url: string
      readonly collectionPrefix: string
      readonly hasSecret: boolean
    }
    readonly queryTimeoutMs: number
    readonly storeTimeoutMs: number
  }
  readonly search: {
    readonly topK: number
    readonly snippetChars: number
    readonly weights: {
      readonly title: number
      readonly aliases: number
      readonly questions: number
      readonly content: number
    }
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

// Browsers replace a NUL in an option value, so the marker is plain text no model or prefix would be.
const CUSTOM = "::custom::"
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
    fields: [
      toggle("vector.enabled"),
      choice("vector.model"),
      choice("vector.queryPrefix"),
      choice("vector.documentPrefix"),
      number("vector.queryTimeoutMs"),
    ],
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

const sections = ["vector", "store", "search", "import", "terms"] as const

const numbers = groups
  .flatMap((group) => group.fields.filter((field) => field.kind === "number").map((field) => field.path))
  .concat("vector.storeTimeoutMs")

const read = (value: unknown, path: string) =>
  path
    .split(".")
    .reduce<unknown>(
      (current, key) =>
        typeof current === "object" && current !== null ? (current as Record<string, unknown>)[key] : undefined,
      value,
    )

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
function KnowledgeSettings(props: {
  base?: string
  layout?: "inline" | "dialog"
  onClose?: () => void
  request: <T>(path: string, method?: string, body?: unknown) => Promise<T>
}) {
  const language = useLanguage()
  const path = () =>
    props.base ? `/api/knowledge/bases/${encodeURIComponent(props.base)}/settings` : "/api/knowledge/settings"
  const [state, setState] = createStore({
    pending: false,
    edits: {} as Record<string, string | boolean>,
    custom: {} as Record<string, boolean>,
    secret: "",
    store: "",
    terms: undefined as string | undefined,
    tested: "",
    reindexed: "",
    section: "vector",
  })
  const [loaded, { refetch }] = createResource(
    () => props.base ?? "platform",
    () =>
      props
        .request<{ effective: Settings } | Settings>(path())
        .then((value) => ("effective" in value ? value.effective : value)),
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
    const withTerms =
      state.terms === undefined
        ? withSecret
        : merge(withSecret, {
            terms: state.terms
              .split("\n")
              .map((line) => line.trim())
              .filter(Boolean),
          })
    setState("pending", true)
    try {
      await props.request(path(), "PATCH", withTerms)
      setState({ edits: {}, custom: {}, secret: "", store: "", terms: undefined })
      await refetch()
      showToast({ variant: "success", title: language.t("account.knowledge.settings.saved") })
      props.onClose?.()
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

  const reindex = async (base: string) => {
    setState("pending", true)
    try {
      const result = await props.request<{ indexed: number }>(
        `/api/knowledge/bases/${encodeURIComponent(base)}/reindex`,
        "POST",
      )
      setState("reindexed", language.plural("account.knowledge.settings.reindexed", result.indexed))
    } catch (error) {
      setState("reindexed", error instanceof AccountError ? error.message : language.t("account.knowledge.failed"))
    } finally {
      setState("pending", false)
    }
  }

  const test = async () => {
    setState("pending", true)
    try {
      const result = await props.request<{ ok: boolean; ms: number }>("/api/knowledge/vector-store/test", "POST", {
        vector: {
          store: {
            type: state.store || current()?.vector.store.type,
            url: String(value("vector.store.url")),
            ...(state.secret ? { secret: state.secret } : {}),
          },
        },
      })
      setState(
        "tested",
        language.t(result.ok ? "account.knowledge.settings.reachable" : "account.knowledge.settings.unreachable", {
          ms: result.ms,
        }),
      )
    } catch (error) {
      setState("tested", error instanceof AccountError ? error.message : language.t("account.knowledge.failed"))
    } finally {
      setState("pending", false)
    }
  }

  // The dialog shows one section at a time; inline, every section is stacked.
  const shown = (id: string) => props.layout !== "dialog" || state.section === id
  const dirty = () =>
    Object.keys(state.edits).length > 0 || state.store !== "" || state.secret !== "" || state.terms !== undefined
  const store = () => state.store || current()?.vector.store.type || "builtin"
  const [catalog] = createResource(() =>
    props.request<{ chat: Choice[]; embedding: Choice[] }>("/api/knowledge/models"),
  )
  // Only models set up under Settings > Models are offered; a saved value outside them shows as custom.
  const options = (field: string): ReadonlyArray<Choice> => {
    if (field === "import.model") return catalog.latest?.chat ?? []
    if (field === "vector.model") return catalog.latest?.embedding ?? []
    return presets[field] ?? []
  }
  const custom = (field: string) =>
    state.custom[field] ||
    (!(field.endsWith(".model") && value(field) === "") && !options(field).some((item) => item.value === value(field)))
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
      <select
        value={custom(field.path) ? CUSTOM : String(value(field.path))}
        disabled={field.path.endsWith(".model") && catalog.loading && !catalog.latest}
        onChange={(event) => pick(field.path, event.currentTarget.value)}
      >
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
            <input
              type="checkbox"
              checked={Boolean(value(field.path))}
              onChange={(event) => setState("edits", field.path, event.currentTarget.checked)}
            />
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
        <div data-component="knowledge-settings" data-layout={props.layout ?? "inline"}>
          <Show when={props.layout === "dialog"}>
            <nav class="knowledge-nav">
              <For each={sections}>
                {(id) => (
                  <button type="button" data-active={state.section === id} onClick={() => setState("section", id)}>
                    {language.t(
                      id === "terms" ? "account.knowledge.settings.terms" : `account.knowledge.settings.group.${id}`,
                    )}
                  </button>
                )}
              </For>
            </nav>
          </Show>
          <div class="knowledge-pane" data-scrollable>
            <For each={groups}>
              {(group) => (
                <section class="knowledge-group" hidden={!shown(group.id)}>
                  <header>
                    <span class="text-13-medium">{language.t(`account.knowledge.settings.group.${group.id}`)}</span>
                    <span class="text-12-regular text-v2-text-text-muted">
                      {language.t(`account.knowledge.settings.group.${group.id}.hint`)}
                    </span>
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
            <section class="knowledge-group" hidden={!shown("store")}>
              <header>
                <span class="text-13-medium">{language.t("account.knowledge.settings.group.store")}</span>
                <span class="text-12-regular text-v2-text-text-muted">
                  {language.t("account.knowledge.settings.group.store.hint")}
                </span>
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
                      placeholder={
                        settings().vector.store.hasSecret ? language.t("account.knowledge.settings.secretSet") : ""
                      }
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
              <Show when={props.base}>
                {(base) => (
                  <div class="knowledge-test">
                    <Button type="button" variant="ghost" disabled={state.pending} onClick={() => void reindex(base())}>
                      {language.t("account.knowledge.settings.reindex")}
                    </Button>
                    <span class="text-12-regular text-v2-text-text-muted">
                      {state.reindexed || language.t("account.knowledge.settings.reindexHint")}
                    </span>
                  </div>
                )}
              </Show>
            </section>
            <section class="knowledge-group" hidden={!shown("terms")}>
              <header>
                <span class="text-13-medium">{language.t("account.knowledge.settings.terms")}</span>
                <span class="text-12-regular text-v2-text-text-muted">
                  {language.t("account.knowledge.settings.termsHint")}
                </span>
              </header>
              <textarea
                rows={4}
                value={state.terms ?? settings().terms.join("\n")}
                onInput={(event) => setState("terms", event.currentTarget.value)}
              />
            </section>
          </div>
          <div class="knowledge-actions">
            <Show when={dirty()}>
              <span class="knowledge-unsaved text-12-regular text-v2-text-text-muted">
                {language.t("account.knowledge.settings.unsaved")}
              </span>
            </Show>
            <Show when={props.onClose}>
              {(close) => (
                <Button type="button" variant="ghost" disabled={state.pending} onClick={() => close()()}>
                  {language.t("account.knowledge.settings.cancel")}
                </Button>
              )}
            </Show>
            <Button
              type="button"
              variant="ghost"
              disabled={state.pending || !dirty()}
              onClick={() => setState({ edits: {}, custom: {}, secret: "", store: "", terms: undefined, tested: "" })}
            >
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
