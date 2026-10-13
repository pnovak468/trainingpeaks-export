const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("tp", {
  platform: process.platform,
  state: () => ipcRenderer.invoke("state"),
  signIn: () => ipcRenderer.invoke("sign-in"),
  signOut: () => ipcRenderer.invoke("sign-out"),
  download: (choice) => ipcRenderer.invoke("download", choice),
  stop: () => ipcRenderer.invoke("stop"),
  show: (path) => ipcRenderer.invoke("show", path),
  onProgress: (listener) => ipcRenderer.on("progress", (_event, value) => listener(value)),
});
