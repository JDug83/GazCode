const { contextBridge, ipcRenderer } = require("electron");

// The only things the web page can ask the desktop shell to do.
contextBridge.exposeInMainWorld("gazDesktop", {
  isDesktop: true,
  openFiles: () => ipcRenderer.invoke("disk:openFiles"),
  openFolder: () => ipcRenderer.invoke("disk:openFolder"),
  readFile: (p) => ipcRenderer.invoke("disk:readFile", p),
  writeFile: (p, data) => ipcRenderer.invoke("disk:writeFile", p, data),
  saveAs: (name, data) => ipcRenderer.invoke("disk:saveAs", name, data),
});
