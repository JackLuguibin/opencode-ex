export async function copyText(text: string) {
  if (navigator.clipboard?.writeText) return navigator.clipboard.writeText(text)

  // The Clipboard API is unavailable when the web app is served over plain HTTP on a LAN.
  const active = document.activeElement
  const field = document.createElement("textarea")
  field.value = text
  field.readOnly = true
  field.style.cssText = "position:fixed;inset:0 auto auto 0;opacity:0;pointer-events:none"
  document.body.append(field)
  try {
    field.focus({ preventScroll: true })
    field.select()
    if (!document.execCommand("copy")) throw new Error("Clipboard write failed")
  } finally {
    field.remove()
    if (active instanceof HTMLElement) active.focus({ preventScroll: true })
  }
}
