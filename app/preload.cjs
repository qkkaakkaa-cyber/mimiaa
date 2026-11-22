const { contextBridge, ipcRenderer } = require("electron");
const invoke = async (name, value) => {
  const response = await ipcRenderer.invoke(name, value);
  if (!response.ok) throw new Error(response.error);
  return response.data;
};
contextBridge.exposeInMainWorld("huixiang", {
  load: () => invoke("workspace:load"),
  saveSettings: (value) => invoke("settings:save", value),
  saveFAQ: (value) => invoke("faq:save", value),
  removeFAQ: (id) => invoke("faq:remove", id),
  permissions: () => invoke("native:permissions"),
  requestPermission: (type) => invoke("native:request-permission", type),
  windows: () => invoke("native:windows"),
  preview: (id) => invoke("native:preview", id),
  read: () => invoke("agent:read"),
  generate: () => invoke("agent:generate"),
  start: () => invoke("agent:start"),
  stop: () => invoke("agent:stop"),
  send: (text) => invoke("agent:send", text),
  saveKey: (value) => invoke("model:save-key", value),
  testModel: () => invoke("model:test"),
  openSettings: (type) => invoke("app:open-settings", type),
  openDataFolder: () => invoke("app:data-folder"),
  onState: (callback) => {
    const listener = (_event, state) => callback(state);
    ipcRenderer.on("agent:state", listener);
    return () => ipcRenderer.removeListener("agent:state", listener);
  },
});
