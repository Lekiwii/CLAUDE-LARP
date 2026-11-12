'use strict';
// The renderer gets a small, explicit API and nothing else: no Node, no fs.
const { contextBridge, ipcRenderer } = require('electron');

const subscribe = (channel) => (fn) => {
  const handler = (_event, value) => fn(value);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
};

contextBridge.exposeInMainWorld('larp', {
  init: () => ipcRenderer.invoke('larp:init'),
  start: (opts) => ipcRenderer.invoke('larp:start', opts),
  openRepo: () => ipcRenderer.invoke('larp:open-repo'),
  write: (data) => ipcRenderer.send('larp:write', data),
  resize: (cols, rows) => ipcRenderer.send('larp:resize', { cols, rows }),
  setTheme: (theme) => ipcRenderer.send('larp:theme', theme),
  setView: (view) => ipcRenderer.send('larp:view', view),
  setScene: (scene) => ipcRenderer.send('larp:scene', scene),
  progress: (state) => ipcRenderer.send('larp:progress', state),
  scan: () => ipcRenderer.invoke('larp:scan'),
  scanDeep: () => ipcRenderer.invoke('larp:scan-deep'),
  copy: (text) => ipcRenderer.send('larp:clipboard-write', text),
  openExternal: (url) => ipcRenderer.send('larp:open-external', url),
  onData: subscribe('larp:pty-data'),
  onEvents: subscribe('larp:events'),
  onSession: subscribe('larp:session'),
  onGit: subscribe('larp:git'),
  onHost: subscribe('larp:host'),
});
