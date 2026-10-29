import { createEffect, ErrorBoundary, Show, type JSX } from "solid-js"
import { Composer } from "@/composer/composer"
import { createComposerModel } from "@/composer/model"
import { CommentsProvider } from "@/composer/comments"
import { ComposerPersistenceProvider } from "@/composer/persistence"
import { createStartComposerAdapter } from "@/new-session/composer-adapter"
import { ModelsProvider } from "@/providers/models/models"
import { ServerProvider } from "@/runtime/server/current"
import { ServerConnection } from "@/runtime/server/registry"
import { ErrorPage } from "@/shell/errors/error"
import { SessionUIProvider } from "@/shell/routes/session-ui-provider"
import { FileProvider } from "@/workspaces/files/model"
import { LocationProvider } from "@/workspaces/location"

/**
 * The session page's composer, for a project Home has selected: sending creates the session in the project's folder
 * and opens it. Home sits outside any Location, so this mounts the same providers the new-session page does.
 */
export function HomeComposer(props: { conn: ServerConnection.Any; directory: string; children?: JSX.Element }) {
  return (
    <Show when={`${ServerConnection.key(props.conn)}\0${props.directory}`} keyed>
      <Show when={props.conn} keyed>
        {(conn) => (
          <ServerProvider conn={conn}>
            <ErrorBoundary fallback={(error) => <ErrorPage error={error} />}>
              <ModelsProvider directory={props.directory}>
                <LocationProvider directory={props.directory}>
                  <SessionUIProvider directory={props.directory} server={ServerConnection.key(conn)}>
                    <FileProvider>
                      <ComposerPersistenceProvider>
                        <CommentsProvider>
                          <HomeComposerContent>{props.children}</HomeComposerContent>
                        </CommentsProvider>
                      </ComposerPersistenceProvider>
                    </FileProvider>
                  </SessionUIProvider>
                </LocationProvider>
              </ModelsProvider>
            </ErrorBoundary>
          </ServerProvider>
        )}
      </Show>
    </Show>
  )
}

function HomeComposerContent(props: { children?: JSX.Element }) {
  const composer = createStartComposerAdapter({
    worktree: () => "main",
    branch: () => undefined,
    submitted: () => undefined,
  })
  const model = createComposerModel(composer.adapter)

  createEffect(() => {
    if (composer.ready()) model.restoreFocus()
  })

  return (
    <div class="flex flex-col-reverse">
      <div class="relative z-10">
        <Composer model={model} />
      </div>
      {props.children}
    </div>
  )
}
