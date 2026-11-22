const { contextBridge, ipcRenderer } = require("electron");
const invoke = async (name, value) => {
  const response = await ipcRenderer.invoke(name, value);
  if (!response.ok) throw new Error(response.error);
  return response.data;
};
contextBridge.exposeInMainWorld("huixiang", {
  wechatToolsLoad: () => invoke("wechat-tools:load"),
  wechatToolsSettings: (value) => invoke("wechat-tools:settings", value),
  wechatProfile: () => invoke("wechat-tools:profile"),
  wechatLearnProfile: () => invoke("wechat-tools:learn-profile"),
  wechatContacts: () => invoke("wechat-tools:contacts"),
  wechatChats: () => invoke("wechat-tools:chats"),
  wechatMoments: () => invoke("wechat-tools:feed"),
  wechatMomentsScan: () => invoke("wechat-tools:scan"),
  wechatMomentEditor: (value) => invoke("wechat-tools:editor", value),
  copyMoment: (text) => invoke("wechat-tools:copy", text),
  load: () => invoke("workspace:load"),
  saveSettings: (value) => invoke("settings:save", value),
  saveFAQ: (value) => invoke("faq:save", value),
  removeFAQ: (id) => invoke("faq:remove", id),
  importDocument: () => invoke("knowledge:import"),
  removeDocument: (id) => invoke("knowledge:remove", id),
  practice: (text) => invoke("agent:practice", text),
  smartLayout: (id) => invoke("native:smart-layout", id),
  discover: () => invoke("agent:discover"),
  summarySessions: () => invoke("agent:summary-sessions"),
  summarizeCurrent: (id) => invoke("agent:summarize-current", id),
  reviewTask: (id) => invoke("agent:review-task", id),
  testJobs: () => invoke("jobs:test"),
  retryCurrent: (value) => invoke("agent:retry-current", value),
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
