import { useDirectoryPicker } from "@/workspaces/selection/picker"
import { useServerActionsController } from "@/servers/registry/controller"
import { useSettingsCommand } from "@/settings/command"
import { useSettingsSurface } from "@/settings/surface"
import { type LocalProject } from "@/shell/state/layout"
import { useLanguage } from "@/runtime/i18n/language"
import { usePlatform } from "@/runtime/platform/platform"
import { ServerConnection } from "@/runtime/server/registry"
import { errorMessage, homeProjectDirectories } from "@/shell/layout/helpers"
import { Persist, persisted } from "@/runtime/persistence/storage"
import { showToast } from "@/shell/notifications/toast"
import { useDialog } from "@opencode/ui/context/dialog"
import { useNavigate } from "@solidjs/router"
import { createEffect, createResource } from "solid-js"
import { Schema } from "effect"
import { Persistence } from "@/runtime/persistence/schema"
import type { HomeController } from "../model"
import { useGlobal } from "@/runtime/server/runtime"
import { useRevealProject } from "./reveal"
import { displayName } from "@opencode/ui/project-avatar"
import { useAccountOptional } from "@/identity/gate"
import { PluginConfirmDialog } from "@/runtime/plugin/dialogs"
import { formatServerError } from "@/runtime/server/errors"
import { isSharedDirectory, sharedDirectory as sharedPath } from "../shared/path"

export const HomeServersSchema = Schema.Struct({
  collapsed: Persistence.record(Persistence.fallback(Schema.Boolean, () => false)),
})

export function createHomeProjectsController(home: HomeController) {
  const platform = usePlatform()
  const navigate = useNavigate()
  const pickDirectory = useDirectoryPicker()
  const dialog = useDialog()
  const language = useLanguage()
  const openSettings = useSettingsCommand()
  const settings = useSettingsSurface()
  const serverManagement = useServerActionsController()
  const global = useGlobal()
  const revealProject = useRevealProject()
  const account = useAccountOptional()

  // The organization's default directory is where sessions without a project go, so it can't be deleted.
  const defaultDirectory = () => {
    const root = account?.session.organizationDirectory

    return root ? `${root.replace(/[\\/]+$/, "")}/默认目录` : undefined
  }

  const sharedDirectory = () => sharedPath(account?.session.organizationDirectory)
  const isShared = (worktree: string) => isSharedDirectory(account?.session.organizationDirectory, worktree)
  // The shared space is its own entry beside the projects, never one of them, and can't be deleted.
  const withoutShared = (ordered: LocalProject[]) => ordered.filter((project) => !isShared(project.worktree))
  const registering = new Set<string>()

  // The shared space becomes a project the first time anyone in the organization opens home, so everyone sees it.
  createEffect(() => {
    const shared = sharedDirectory()
    const conn = home.server.list().find((item) => ServerConnection.key(item) === home.selection.value().server)

    if (!shared || !conn) return
    const ctx = home.server.context(conn)

    if (!ctx.sync.project.ready() || ctx.projects.forDirectory(shared) || registering.has(shared)) return
    registering.add(shared)
    void ctx.sdk.api.location
      .get({ location: { directory: shared } })
      .then(() => ctx.sync.project.refresh())
      .catch(() => registering.delete(shared))
  })

  // In an organization only its admins take projects out of the list or delete them for good.
  const isAdmin = () => !account || account.session.admin || account.session.organizationAdmin

  // Takes the project off the organization's lists. Its sessions and folder stay, and opening the folder again restores it.
  async function archiveProject(conn: ServerConnection.Any, project: LocalProject) {
    if (!project.id) return
    const ctx = home.server.context(conn)
    const name = displayName(project)
    const result = await ctx.sdk.api.project.update({ projectID: project.id, archived: true }).catch((error: unknown) => {
      showToast({ variant: "error", title: language.t("common.requestFailed"), description: formatServerError(error, language.t) })
    })

    if (!result) return
    ctx.projects.hide(project)
    await ctx.sync.project.refresh()
    showToast({ variant: "success", icon: "circle-check", title: language.t("sidebar.project.archive.done", { name }) })
  }

  async function deleteProject(conn: ServerConnection.Any, project: LocalProject) {
    if (!project.id) return
    const ctx = home.server.context(conn)
    const name = displayName(project)
    const result = await ctx.sdk.api.project.remove({ projectID: project.id }).catch((error: unknown) => {
      showToast({ variant: "error", title: language.t("common.requestFailed"), description: formatServerError(error, language.t) })
    })

    if (!result) return
    ctx.projects.hide(project)
    await ctx.sync.project.refresh()
    showToast({
      variant: "success",
      icon: "circle-check",
      title: language.t(result.files ? "sidebar.project.delete.done" : "sidebar.project.delete.kept", { name }),
    })
  }
  const [_state, setState, _, ready] = persisted(Persist.global("home.servers"), HomeServersSchema, { collapsed: {} })

  const [state] = createResource(
    () => ready.promise ?? Promise.resolve(),
    (promise) => promise.then(() => _state),
    { initialValue: _state },
  )

  function edit(conn: ServerConnection.Http, onSave?: (saved: ServerConnection.Http) => void) {
    void import("@/servers/connect/dialog").then(({ DialogServer }) => {
      void dialog.show(() => <DialogServer mode="edit" server={conn} onSave={(saved) => onSave?.(saved)} />)
    })
  }

  // An expired pairing session or a changed password signs the app out of an HTTP server; signing in again edits it,
  // and the action that asked for sign-in continues once the dialog saves, as it does for plugin servers. It continues
  // with the saved connection: the one it started with still carries the rejected credentials.
  function authenticate(conn: ServerConnection.Any, onConnected?: (conn: ServerConnection.Any) => void) {
    if (conn.type !== "http" || !home.server.health(conn)?.unauthorized)
      return ServerConnection.authenticate(conn, () => onConnected?.(conn))
    edit(conn, onConnected)

    return true
  }

  function directories(project: LocalProject) {
    return [project.worktree, ...(project.sandboxes ?? [])]
  }

  function choose(conn: ServerConnection.Any) {
    pickDirectory({
      server: conn,
      title: language.t("command.project.open"),
      multiple: true,
      onSelect: (result) => void home.project.add(conn, homeProjectDirectories(result)),
    })
  }

  return {
    copy: {
      language,
    },
    selection: {
      value: home.selection.value,
    },
    server: {
      list: home.server.list,
      health: home.server.health,
      label: home.server.label,
      projects: (conn: ServerConnection.Any) => withoutShared(home.project.forServer(conn)),
      collapsed: (conn: ServerConnection.Any) => state().collapsed[ServerConnection.key(conn)] ?? false,
      toggleCollapsed: (conn: ServerConnection.Any) => {
        const key = ServerConnection.key(conn)
        setState("collapsed", key, !state().collapsed[key])
      },
      canRemove: (conn: ServerConnection.Any) => serverManagement.connection.canRemove(ServerConnection.key(conn)),
      canEdit: (conn: ServerConnection.Any) => serverManagement.connection.canEdit(ServerConnection.key(conn)),
      remove: (conn: ServerConnection.Any) => serverManagement.connection.remove(ServerConnection.key(conn)),
      canHide: (conn: ServerConnection.Any) => serverManagement.connection.canHide(ServerConnection.key(conn)),
      hide: (conn: ServerConnection.Any) => serverManagement.connection.setHidden(ServerConnection.key(conn), true),
      edit: (conn: ServerConnection.Http) => edit(conn),
      authenticate: (conn: ServerConnection.Any) => authenticate(conn),
      focus: (conn: ServerConnection.Any) => {
        if (authenticate(conn, (next) => home.selection.focusServer(next))) return
        home.selection.focusServer(conn)
      },
    },
    shared: {
      directory: sharedDirectory,
      selected: () => {
        const directory = home.selection.value().directory

        return !!directory && isShared(directory)
      },
      open: () => {
        const conn = home.server.focused()
        const directory = sharedDirectory()

        if (!conn || !directory) return
        home.selection.set({ server: ServerConnection.key(conn), directory })
        // A session tab may be showing; the shared space lives on the home view.
        navigate("/")
      },
    },
    project: {
      list: () => withoutShared(home.project.list()),
      select: (conn: ServerConnection.Any, directory: string) => {
        if (authenticate(conn, (next) => home.project.select(next, directory))) return
        home.project.select(conn, directory)
      },
      add: home.project.add,
      openNewSession: (conn: ServerConnection.Any, directory: string) => {
        if (authenticate(conn, (next) => home.project.openProjectNewSession(next, directory))) return
        home.project.openProjectNewSession(conn, directory)
      },
      canImportSession: !!platform.openAttachmentPickerDialog,
      importSession: (conn: ServerConnection.Any, project: LocalProject) => {
        if (!platform.openAttachmentPickerDialog) return
        void platform
          .openAttachmentPickerDialog(
            {
              title: language.t("command.session.import"),
              accept: ["application/json"],
              extensions: ["json"],
            },
            async (file) => {
              const data = await Schema.decodeUnknownPromise(
                Schema.fromJsonString(Schema.Record(Schema.String, Schema.Json)),
              )(await file.text())

              const api = home.server.context(conn).sdk.api.session

              // SAFETY: the import endpoint validates the transcript, including exports written by earlier releases.
              const imported = await api.import({
                ...data,
                location: { directory: project.worktree },
              } as Parameters<typeof api.import>[0])

              home.project.openProjectSession(conn, project.worktree, imported)
            },
          )
          .catch((cause: unknown) => {
            showToast({
              title: language.t("common.requestFailed"),
              description: errorMessage(cause, language.t("common.requestFailed")),
            })
          })
      },
      edit: (conn: ServerConnection.Any, project: LocalProject) => {
        settings.openProject({
          server: ServerConnection.key(conn),
          project: project.worktree,
        })
      },
      hasUnread: (conn: ServerConnection.Any, project: LocalProject) => {
        const notification = global.ensureServerCtx(conn).notification

        return directories(project).some((directory) => notification.project.hasUnread(directory))
      },
      clearNotifications: (conn: ServerConnection.Any, project: LocalProject) => {
        const notification = global.ensureServerCtx(conn).notification
        directories(project).forEach((directory) => notification.project.markViewed(directory))
      },
      choose: (conn: ServerConnection.Any) => {
        if (authenticate(conn, (next) => choose(next))) return

        if (home.server.health(conn)?.healthy === false) return
        choose(conn)
      },
      hide: (conn: ServerConnection.Any, project: LocalProject) => home.server.context(conn).projects.hide(project),
      canDelete: (_conn: ServerConnection.Any, project: LocalProject) =>
        isAdmin() && !!project.id && project.worktree !== defaultDirectory() && !isShared(project.worktree),
      archive: (conn: ServerConnection.Any, project: LocalProject) =>
        dialog.show(() => (
          <PluginConfirmDialog
            options={{
              title: language.t("sidebar.project.archive.title", { name: displayName(project) }),
              description: language.t("sidebar.project.archive.description"),
              confirm: language.t("sidebar.project.archive.confirm"),
            }}
            done={(confirmed) => {
              dialog.close()
              if (confirmed) void archiveProject(conn, project)
            }}
          />
        )),
      delete: (conn: ServerConnection.Any, project: LocalProject) =>
        dialog.show(() => (
          <PluginConfirmDialog
            options={{
              title: language.t("sidebar.project.delete.title", { name: displayName(project) }),
              description: language.t("sidebar.project.delete.description"),
              confirm: language.t("sidebar.project.delete.confirm"),
              danger: true,
            }}
            done={(confirmed) => {
              dialog.close()
              if (confirmed) void deleteProject(conn, project)
            }}
          />
        )),
      isPinned: (conn: ServerConnection.Any, project: LocalProject) =>
        home.server.context(conn).projects.pinned().includes(project.worktree),
      togglePin: (conn: ServerConnection.Any, project: LocalProject) =>
        home.server.context(conn).projects.togglePin(project.worktree),
      reorder: (conn: ServerConnection.Any, worktrees: string[]) =>
        home.server.context(conn).projects.reorder(worktrees),
      canReveal: revealProject.available,
      reveal: revealProject.reveal,
    },
    utility: {
      settings: openSettings,
    },
  }
}

export type HomeProjectsController = ReturnType<typeof createHomeProjectsController>
