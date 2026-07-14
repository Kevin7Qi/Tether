const { contextBridge, ipcRenderer } = require("electron");

function subscribe(channel, callback) {
  const handler = (_event, payload) => callback(payload);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
}

contextBridge.exposeInMainWorld("remoteMarkdown", {
  getUiStateSync: () => ipcRenderer.sendSync("state:getUiState"),
  saveUiState: (patch) => ipcRenderer.invoke("state:saveUiState", patch),
  getDefaultPrivateKeyPath: () => ipcRenderer.invoke("remote:getDefaultPrivateKeyPath"),
  getConnectionProfile: (connection) => ipcRenderer.invoke("remote:getConnectionProfile", connection),
  healthCheck: (context) => ipcRenderer.invoke("app:healthCheck", context),
  copyText: (text) => ipcRenderer.invoke("app:copyText", text),
  saveTextAs: (payload) => ipcRenderer.invoke("app:saveTextAs", payload),
  selectPrivateKey: () => ipcRenderer.invoke("remote:selectPrivateKey"),
  connectAndOpen: (connection) => ipcRenderer.invoke("remote:connectAndOpen", connection),
  disconnect: () => ipcRenderer.invoke("remote:disconnect"),
  openFile: (remotePath) => ipcRenderer.invoke("remote:openFile", remotePath),
  downloadRemoteFile: (remotePath) => ipcRenderer.invoke("remote:downloadFile", remotePath),
  listDirectory: (remotePath) => ipcRenderer.invoke("remote:listDirectory", remotePath),
  startWatching: (options) => ipcRenderer.invoke("remote:startWatching", options),
  stopWatching: () => ipcRenderer.invoke("remote:stopWatching"),
  saveFile: (payload) => ipcRenderer.invoke("remote:saveFile", payload),
  createRemoteFile: (payload) => ipcRenderer.invoke("remote:createFile", payload),
  readLocalSample: () => ipcRenderer.invoke("local:readSample"),
  openLocalFile: () => ipcRenderer.invoke("local:openFile"),
  readLocalFile: (filePath) => ipcRenderer.invoke("local:readFile", filePath),
  openLocalDirectory: () => ipcRenderer.invoke("local:openDirectory"),
  listLocalDirectory: (directory) => ipcRenderer.invoke("local:listDirectory", directory),
  saveLocalFile: (payload) => ipcRenderer.invoke("local:saveFile", payload),
  createLocalFile: (payload) => ipcRenderer.invoke("local:createFile", payload),
  saveLocalSample: (content) => ipcRenderer.invoke("local:saveSample", content),
  onEditorCommand: (callback) => subscribe("editor:command", callback),
  onStatus: (callback) => subscribe("remote:status", callback),
  onUpdate: (callback) => subscribe("remote:update", callback),
  onError: (callback) => subscribe("remote:error", callback)
});
