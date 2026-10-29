import { createResource, createSignal, For, Show } from "solid-js"
import { Button } from "@opencode/ui/button"
import { Dialog, DialogBody, DialogFooter, DialogHeader, DialogTitleGroup } from "@opencode/ui/dialog"
import { useDialog } from "@opencode/ui/context/dialog"
import { Select } from "@opencode/ui/select"
import { TextInput } from "@opencode/ui/text-input"
import { useLanguage } from "@/runtime/i18n/language"
import type { ServerConnection } from "@/runtime/server/registry"
import { accountFetch, AccountError, type AccountJoinRequest } from "./api"

const statusKey = {
  pending: "account.join.status.pending",
  approved: "account.join.status.approved",
  rejected: "account.join.status.rejected",
} as const

/** Ask to join an organization, and see how earlier requests went. */
export function JoinRequestDialog(props: {
  server: ServerConnection.Http
  /** Called after a request is sent. */
  sent: () => void
}) {
  const language = useLanguage()
  const dialog = useDialog()
  const request = <T,>(path: string, body?: unknown) =>
    accountFetch<T>({ url: props.server.http.url, password: props.server.http.password, path, body })
  const [organizations] = createResource(() => request<{ id: string; name: string }[]>("/api/auth/joinable-organizations"))
  const [mine, { refetch }] = createResource(() => request<AccountJoinRequest[]>("/api/auth/join-requests"))
  const [selected, setSelected] = createSignal("")
  const [note, setNote] = createSignal("")
  const [error, setError] = createSignal("")
  const [pending, setPending] = createSignal(false)

  const open = (id: string) => mine()?.some((item) => item.organizationID === id && item.status === "pending")
  const available = () => (organizations() ?? []).filter((item) => !open(item.id))

  const submit = async (event: Event) => {
    event.preventDefault()
    const organizationID = selected() || available()[0]?.id
    if (!organizationID) return
    setPending(true)
    setError("")
    await request("/api/auth/join-requests", { organizationID, note: note().trim() || undefined })
      .then(() => {
        setNote("")
        setSelected("")
        props.sent()
        return refetch()
      })
      .catch((cause) => setError(cause instanceof AccountError && cause.message ? cause.message : language.t("common.requestFailed")))
      .finally(() => setPending(false))
  }

  const current = () => available().find((item) => item.id === selected()) ?? available()[0]

  return (
    <Dialog fit>
      <DialogHeader>
        <DialogTitleGroup
          title={language.t("account.join.title")}
          description={language.t("account.join.description")}
        />
      </DialogHeader>
      <form class="contents" onSubmit={(event) => void submit(event)}>
        <DialogBody class="flex flex-col gap-4 px-4">
          <Show
            when={available().length > 0}
            fallback={<p class="py-2 text-14-regular text-v2-text-text-muted">{language.t("account.join.none")}</p>}
          >
            <div class="flex flex-col gap-1.5">
              <span class="text-12-medium text-v2-text-text-muted">{language.t("account.join.organization")}</span>
              <Select
                // The inline control is borderless and 280px; here it is the dialog's main field, so it gets an outline and the full width.
                class="!h-10 !w-full !border !border-solid !border-v2-border-border-strong !text-14-regular"
                options={available()}
                current={current()}
                value={(item) => item.id}
                label={(item) => item.name}
                onSelect={(item) => item && setSelected(item.id)}
              />
            </div>
            <div class="flex flex-col gap-1.5">
              <span class="text-12-medium text-v2-text-text-muted">{language.t("account.join.note")}</span>
              <TextInput
                appearance="large"
                class="!w-full self-stretch"
                value={note()}
                maxLength={500}
                autocomplete="off"
                onInput={(event) => setNote(event.currentTarget.value)}
              />
            </div>
            <Show when={error()}>
              <p role="alert" class="text-12-regular text-v2-text-text-critical">{error()}</p>
            </Show>
          </Show>
          <Show when={(mine()?.length ?? 0) > 0}>
            <div class="flex flex-col gap-2 border-t border-v2-border-border-base pt-3">
              <span class="text-12-medium text-v2-text-text-muted">{language.t("account.join.mine")}</span>
              <ul class="flex flex-col gap-1.5">
                <For each={mine()}>
                  {(item) => (
                    <li class="flex items-center justify-between gap-3 text-13-regular">
                      <span class="truncate">{item.organizationName}</span>
                      <span
                        class="shrink-0 rounded-full border border-v2-border-border-base px-2 text-11-regular"
                        classList={{
                          "text-v2-text-text-muted": item.status === "pending",
                          "text-v2-text-text-critical": item.status === "rejected",
                        }}
                      >
                        {language.t(statusKey[item.status])}
                      </span>
                    </li>
                  )}
                </For>
              </ul>
            </div>
          </Show>
        </DialogBody>
        <DialogFooter>
          <Button type="button" variant="ghost" onClick={() => dialog.close()}>
            {language.t("common.cancel")}
          </Button>
          <Button type="submit" variant="contrast" disabled={pending() || available().length === 0}>
            {language.t("account.join.submit")}
          </Button>
        </DialogFooter>
      </form>
    </Dialog>
  )
}

/** Open requests the signed-in admin may decide. */
export function JoinApprovalDialog(props: {
  server: ServerConnection.Http
  /** Called with the number still waiting after each change. */
  changed: (pending: number) => void
}) {
  const language = useLanguage()
  const dialog = useDialog()
  const request = <T,>(path: string, body?: unknown) =>
    accountFetch<T>({ url: props.server.http.url, password: props.server.http.password, path, body })
  const [requests, { refetch }] = createResource(() => request<AccountJoinRequest[]>("/api/auth/join-requests/pending"))
  const [error, setError] = createSignal("")
  const [busy, setBusy] = createSignal("")

  const decide = async (id: string, approve: boolean) => {
    setBusy(id)
    setError("")
    await request(`/api/auth/join-requests/${encodeURIComponent(id)}/decision`, { approve })
      .catch((cause) => setError(cause instanceof AccountError && cause.message ? cause.message : language.t("common.requestFailed")))
      .then(() => refetch())
      .then((next) => props.changed(next?.length ?? 0))
      .finally(() => setBusy(""))
  }

  return (
    <Dialog fit>
      <DialogHeader>
        <DialogTitleGroup
          title={language.t("account.join.approvals")}
          description={language.t("account.join.approvals.description")}
        />
      </DialogHeader>
      <DialogBody class="px-4">
        <Show when={error()}>
          <p role="alert" class="mb-2 text-12-regular text-v2-text-text-critical">{error()}</p>
        </Show>
        <Show
          when={(requests()?.length ?? 0) > 0}
          fallback={<p class="text-12-regular text-v2-text-text-muted">{language.t("account.join.approvals.empty")}</p>}
        >
          <ul class="flex flex-col gap-3">
            <For each={requests()}>
              {(item) => (
                <li class="flex items-center justify-between gap-4">
                  <div class="min-w-0 text-12-regular">
                    <div class="truncate">
                      <span class="text-12-medium">{item.name ?? item.employeeID}</span>
                      <Show when={item.name}>
                        <span class="ms-1.5 text-v2-text-text-muted">{item.employeeID}</span>
                      </Show>
                      <span class="ms-1.5 text-v2-text-text-muted">→ {item.organizationName}</span>
                    </div>
                    <Show when={item.note}>
                      <div class="truncate text-v2-text-text-muted">{item.note}</div>
                    </Show>
                  </div>
                  <div class="flex shrink-0 gap-2">
                    <Button variant="ghost-muted" disabled={busy() === item.id} onClick={() => void decide(item.id, false)}>
                      {language.t("account.join.reject")}
                    </Button>
                    <Button variant="contrast" disabled={busy() === item.id} onClick={() => void decide(item.id, true)}>
                      {language.t("account.join.approve")}
                    </Button>
                  </div>
                </li>
              )}
            </For>
          </ul>
        </Show>
      </DialogBody>
      <DialogFooter>
        <Button type="button" variant="ghost" onClick={() => dialog.close()}>
          {language.t("common.close")}
        </Button>
      </DialogFooter>
    </Dialog>
  )
}
