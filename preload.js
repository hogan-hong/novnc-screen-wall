const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
    onInit: (cb) => ipcRenderer.on('init-overlay', (e, data) => cb(data)),
    onLayoutUpdate: (cb) => ipcRenderer.on('layout-update', (e, data) => cb(data)),
    onViewState: (cb) => ipcRenderer.on('view-state', (e, data) => cb(data)),
    refreshView: (index) => ipcRenderer.invoke('refresh-view', index),
    refreshAll: () => ipcRenderer.invoke('refresh-all'),
    toggleFullscreen: () => ipcRenderer.invoke('toggle-fullscreen'),
    getConfig: () => ipcRenderer.invoke('get-config'),
});
