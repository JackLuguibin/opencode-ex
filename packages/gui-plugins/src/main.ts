import { compose } from "@opencode/plugin/gui/host"
import context from "./context"
import btw from "./btw"
import debug from "./debug"
import terminal from "./terminal"
import file from "./file"
import review from "./review"
import details from "./details"
import microsoftOffice from "./microsoft-office"
import sources from "./sources"

/** Built-in plugins with their main entries, by id. Lists every built-in so their ids stay reserved. */
export const builtins = compose({
  context,
  btw,
  debug,
  terminal,
  file,
  review,
  details,
  "microsoft-office": microsoftOffice,
  sources,
})
