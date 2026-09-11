'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('comicgrab', {
  grab: (params) => ipcRenderer.invoke('grab', params),
  cancel: () => ipcRenderer.invoke('cancel'),
  defaultDir: () => ipcRenderer.invoke('defaultDir'),
  chooseDir: (current) => ipcRenderer.invoke('chooseDir', current),
  openPath: (p) => ipcRenderer.invoke('openPath', p),
  showInFolder: (p) => ipcRenderer.invoke('showInFolder', p),
  history: () => ipcRenderer.invoke('history'),
  groupOptions: (url) => ipcRenderer.invoke('groupOptions', url),
  onProgress: (cb) => {
    const handler = (_e, msg) => cb(msg);
    ipcRenderer.on('progress', handler);
    return () => ipcRenderer.removeListener('progress', handler);
  },
});
