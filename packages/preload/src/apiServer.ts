import { ipcRenderer } from 'electron';
import type { startPayload } from '../../api/src/app/types/index';

export async function startServer(payload:startPayload) {
  return ipcRenderer.invoke('start-server', payload);
}

export async function stopServer() {
  return ipcRenderer.invoke('stop-server');
}
