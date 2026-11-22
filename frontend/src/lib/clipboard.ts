/**
 * Copy text to the clipboard. The modern clipboard API only exists on https pages (and localhost); on plain http,
 * e.g. a LAN install, fall back to the older copy command. Resolves false when neither worked, so the caller can
 * show the text for copying by hand.
 */
export async function copyText(text: string): Promise<boolean> {
  if (window.isSecureContext && navigator.clipboard) {
    try {
      await navigator.clipboard.writeText(text)
      return true
    } catch {
      /* e.g. permission refused: try the old way */
    }
  }
  // inside an open dialog or menu, so its focus trap doesn't take the selection away
  const host = document.activeElement?.closest('[role=dialog], [role=menu], [role=alertdialog]') ?? document.body
  const ta = document.createElement('textarea')
  ta.value = text
  ta.setAttribute('readonly', '')
  ta.style.cssText = 'position:fixed;top:0;left:0;width:1px;height:1px;opacity:0'
  host.appendChild(ta)
  ta.focus()
  ta.select()
  ta.setSelectionRange(0, text.length)
  let ok = false
  try {
    ok = document.execCommand('copy')
  } catch {
    ok = false
  }
  ta.remove()
  return ok
}
