const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  getConfig: () => ipcRenderer.invoke('get-config'),
  saveConfig: (config) => ipcRenderer.invoke('save-config', config),
  getStats: () => ipcRenderer.invoke('get-stats'),
  fetchModels: (apiKey) => ipcRenderer.invoke('fetch-models', apiKey),
  
  toggleServer: () => ipcRenderer.send('toggle-server'),
  openWindow: (type) => ipcRenderer.send('open-window', type),
  quit: () => ipcRenderer.send('quit-app'),
  
  setLoginItemSettings: (enable) => ipcRenderer.invoke('set-login-settings', enable),
  getLoginItemSettings: () => ipcRenderer.invoke('get-login-settings'),
  openExternal: (url) => ipcRenderer.send('open-external', url),
  closeWalkthrough: () => ipcRenderer.send('close-walkthrough'),
  
  onLogStream: (callback) => ipcRenderer.on('log-stream', (event, log) => callback(log)),
  onStatsUpdate: (callback) => ipcRenderer.on('stats-update', (event, stats) => callback(stats)),
  onStateChange: (callback) => ipcRenderer.on('state-change', (event, state) => callback(state)),
  
  onInitComplete: (callback) => ipcRenderer.on('init-complete', () => callback()),
  onInitError: (callback) => ipcRenderer.on('init-error', (event, err) => callback(err))
});
