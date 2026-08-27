/**
 * Minimal macOS application menu: About / Quit, Edit roles (copy & paste in password fields),
 * View (reload + DevTools in development only), Window roles and a Help entry to the GitHub repo.
 */
import { Menu, app, type MenuItemConstructorOptions } from 'electron'

export const GITHUB_URL = 'https://github.com/CXBilen/dev-migration-assistant'

export interface MenuOptions {
  isPackaged: boolean
  openExternal: (url: string) => Promise<unknown>
}

export function buildMenuTemplate(options: MenuOptions): MenuItemConstructorOptions[] {
  const template: MenuItemConstructorOptions[] = [
    {
      label: app.name,
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' },
      ],
    },
  ]
  if (!options.isPackaged) {
    template.push({
      label: 'View',
      submenu: [{ role: 'reload' }, { role: 'toggleDevTools' }],
    })
  }
  template.push(
    { role: 'window', submenu: [{ role: 'minimize' }, { role: 'zoom' }, { role: 'close' }] },
    {
      role: 'help',
      submenu: [
        {
          label: 'Dev Migration Assistant on GitHub',
          click: () => {
            void options.openExternal(GITHUB_URL)
          },
        },
      ],
    },
  )
  return template
}

export function installApplicationMenu(options: MenuOptions): void {
  Menu.setApplicationMenu(Menu.buildFromTemplate(buildMenuTemplate(options)))
}
