/**
 * The product name in the tab title. The server that delivers index.html may rewrite its <title> (OPENCODE_WEB_TITLE),
 * so this reads it back before the page's own title tags replace it.
 */
export const appTitle = (typeof document === "undefined" ? "" : document.title) || "OpenCode"

/**
 * Puts the deployment's product name in a translated string. The name of the product itself ("OpenCode Go", "OpenCode
 * Console", "OpenCode V2") and the error-report line keep the upstream wording.
 */
export function branded(text: string) {
  return appTitle === "OpenCode" ? text : text.replace(/\bOpenCode\b(?! (?:Go|Console|Free|Zen|V2|team)\b)/g, appTitle)
}

/** True when the deployment sets its own product name, so the OpenCode logo graphic should give way to the name. */
export const renamed = appTitle !== "OpenCode"
