// The only bridge between the pages and the main process: one `invoke` for
// commands, one `on` for events, and the path of a dropped file.

import { contextBridge, ipcRenderer, webUtils, type IpcRendererEvent } from "electron";

contextBridge.exposeInMainWorld("poupou", {
  invoke: (cmd: string, args?: Record<string, unknown>) => ipcRenderer.invoke("poupou:invoke", cmd, args ?? {}),

  on: (name: string, handler: (payload: unknown) => void) => {
    const listener = (_event: IpcRendererEvent, eventName: string, payload: unknown) => {
      if (eventName === name) handler(payload);
    };
    ipcRenderer.on("poupou:event", listener);
    return () => ipcRenderer.removeListener("poupou:event", listener);
  },

  pathForFile: (file: File) => webUtils.getPathForFile(file),
});
