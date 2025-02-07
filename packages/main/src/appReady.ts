import type { startPayload } from '@api/app/types';
import icon from '@buildResources/icon_32.png';
import { findAppLocale, loadLocale } from '@i18n/index';
import type { Paths } from '@preload/config';
import { app, clipboard, ipcMain, Menu, nativeImage, Tray } from 'electron';
import type { ForkResponse } from './../../api/src/app/types/index';
import { forkAPI } from './forkAPI';
import { restoreOrCreateWindow, showWindow } from './mainWindow';

export default class Ready {
  #isAppQuitting: boolean;
  #api: forkAPI | undefined;
  #tray: Tray|undefined;
  #headless: boolean;

  constructor() {
    this.#isAppQuitting = false;
    this.#api = undefined;
    this.#headless = app.commandLine.hasSwitch('server');
    /** close the API before quitting */
    app.on('before-quit', async() => {
      this.#isAppQuitting = true;
      if(!this.#api) return;
      const stop = await this.#api.stop();
      if(import.meta.env.DEV) {
        if(stop.success) console.log('[api]', 'SHUTDOWN SUCCESS');
        else console.error('[api]', 'SHUTDOWN FAILED');
      }
    });

    const setup = import.meta.env.DEV ? this.devSetup : this.prodSetup;
    setup().then(() => this.#headless ? this.serverSetup() : this.desktopSetup());
  }

  async devSetup() {
    try {
      const imp = await import('electron-devtools-installer');
      await imp.default(
        {
          id: 'nhdogjmejiglipccpnnnanhbledajbpd',
          electron: '>=18.0.2',
        }
        ,{
          loadExtensionOptions: {
            allowFileAccess: true,
          },
        },
      );
    } catch(e) {
      console.log('[main]', 'failed to install extension:', e);
    }
  }

  async prodSetup() {
    try {
      const imp = await import('electron-updater');
      await imp.autoUpdater.checkForUpdatesAndNotify();
    } catch(e) {
      console.log('[main]', 'failed to check for updates', e);
    }
  }

  async serverSetup() {
    if(!app.commandLine.hasSwitch('login')) throw new Error('--login missing');
    if(!app.commandLine.hasSwitch('password')) throw new Error('--password missing');
    if(!app.commandLine.hasSwitch('port')) throw new Error('--port missing');

    const login = app.commandLine.getSwitchValue('login');
    const password = app.commandLine.getSwitchValue('password');
    const portStr = app.commandLine.getSwitchValue('port');

    if(!portStr || typeof portStr !== 'string') throw new Error('--port unexpected value');
    const port = parseInt(portStr);
    if(isNaN(port)) throw new Error('--port unexpected value');

    this.#api = new forkAPI({login,password, port, ssl: 'false' });
    const { fork } = await this.#api.start();
    if(!fork) throw Error('couldnt start server');
    fork.on('message', (msg:ForkResponse) => {
      if(msg.type !== 'shutdownFromWeb') return;
      app.quit();
    });
  }

  async desktopSetup() {
    // create window
    const win = await restoreOrCreateWindow();
    // Prevent application from closing when main window is closed.
    win.on('close', (evt) => {
      if (!this.#isAppQuitting) {
        evt.preventDefault();
        win.hide();
      }
    });

    // system tray icon setup
    const lang = findAppLocale(app.getLocale());
    const locale = await loadLocale(lang);
    this.#tray = new Tray(nativeImage.createFromDataURL(icon));
    const contextMenu = Menu.buildFromTemplate([
      { label: locale.electron.systemtray.show, click: showWindow, type: 'normal'},
      { type: 'separator'},
      { label: locale.electron.systemtray.quit, role: 'quit', type: 'normal' },
    ]);
    this.#tray.setToolTip('Fukayo');
    this.#tray.setContextMenu(contextMenu);

    // IPC

    // start the server from the UI
    ipcMain.handle('start-server', async (ev,  payload: startPayload) => {
      this.#api = new forkAPI(payload);
      const start = await this.#api.start();
      return start.resp;
    });
    // returns user data path
    ipcMain.handle('get-path', (ev, path:Paths) => {
      return app.getPath(path);
    });

    // image to clipboard
    ipcMain.handle('copy-image-to-clipboard', (ev, string: string) => {
      const img = nativeImage.createFromDataURL(string);
      return clipboard.writeImage(img);
    });

  }
}
