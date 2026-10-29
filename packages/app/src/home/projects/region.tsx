import type { JSX } from "solid-js"
import type { HomeProjectsController } from "./controller"
import { HomeProjectsView } from "./view"
import type { HomeScrollController } from "../scroll"

export function HomeProjects(props: {
  projects: HomeProjectsController
  scroll: HomeScrollController
  dropdown?: boolean
  renderSessions?: (worktree: string) => JSX.Element
}) {
  return (
    <HomeProjectsView
      dropdown={props.dropdown}
      renderSessions={props.renderSessions}
      language={props.projects.copy.language}
      servers={props.projects.server.list()}
      projects={props.projects.project.list()}
      selection={props.projects.selection.value()}
      serverHealth={props.projects.server.health}
      serverLabel={props.projects.server.label}
      projectsForServer={props.projects.server.projects}
      collapsed={props.projects.server.collapsed}
      canRevealProject={props.projects.project.canReveal}
      hasUnread={props.projects.project.hasUnread}
      isPinned={props.projects.project.isPinned}
      onTogglePin={props.projects.project.togglePin}
      onReorderProjects={props.projects.project.reorder}
      onWheel={props.scroll.viewport.containWheel}
      onChooseProject={props.projects.project.choose}
      onFocusServer={props.projects.server.focus}
      onAuthenticateServer={props.projects.server.authenticate}
      onToggleCollapsed={props.projects.server.toggleCollapsed}
      onEditServer={props.projects.server.edit}
      canRemoveServer={props.projects.server.canRemove}
      canEditServer={props.projects.server.canEdit}
      onRemoveServer={props.projects.server.remove}
      canHideServer={props.projects.server.canHide}
      onHideServer={props.projects.server.hide}
      onSelectProject={props.projects.project.select}
      onOpenProjectNewSession={props.projects.project.openNewSession}
      canImportSession={props.projects.project.canImportSession}
      onImportSession={props.projects.project.importSession}
      onEditProject={props.projects.project.edit}
      onRevealProject={props.projects.project.reveal}
      onClearNotifications={props.projects.project.clearNotifications}
      onHideProject={props.projects.project.hide}
      canDeleteProject={props.projects.project.canDelete}
      onArchiveProject={props.projects.project.archive}
      onDeleteProject={props.projects.project.delete}
      onOpenSettings={props.projects.utility.settings}
    />
  )
}
