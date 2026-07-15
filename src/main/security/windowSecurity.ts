import type { BrowserWindow, Session } from 'electron'

export function secureWindow(window: BrowserWindow): void {
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  window.webContents.on('will-navigate', (event, url) => {
    if (url !== window.webContents.getURL()) event.preventDefault()
  })
  window.webContents.on('will-redirect', (event) => event.preventDefault())
}

export function secureSession(session: Session, getWindow: () => BrowserWindow | null): void {
  session.setPermissionCheckHandler((webContents, permission, _origin, details) => {
    const window = getWindow()
    if (!window || webContents?.id !== window.webContents.id) return false
    return isAudioOnlyMedia(permission, details)
  })
  session.setPermissionRequestHandler((webContents, permission, callback, details) => {
    const window = getWindow()
    const trusted = Boolean(window && webContents.id === window.webContents.id)
    callback(trusted && isAudioOnlyMedia(permission, details))
  })
}

function isAudioOnlyMedia(
  permission: string,
  details: { mediaTypes?: string[] } | Electron.PermissionCheckHandlerHandlerDetails
): boolean {
  if (permission !== 'media') return false
  const mediaTypes = 'mediaTypes' in details ? (details.mediaTypes ?? []) : []
  return mediaTypes.length === 1 && mediaTypes[0] === 'audio'
}
