const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronNative', {
  invoke: (command, args) => ipcRenderer.invoke('native:invoke', command, args),
});
