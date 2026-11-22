const {
  app,
  BrowserWindow,
  Menu,
  ipcMain,
  safeStorage,
  shell,
  globalShortcut,
  Notification,
  session,
  powerMonitor,
} = require("electron");
const path = require("node:path");
const fs = require("node:fs");
const { fileURLToPath } = require("node:url");
const { Store } = require("./lib/store.cjs");
const { NativeBridge } = require("./lib/native.cjs");
const { Agent } = require("./lib/agent.cjs");
app.setName("回响");
const single = app.requestSingleInstanceLock();
if (!single) app.quit();
let window,
  store,
  agent,
  native,
  sessionKey = "";
const uiFile = path.join(__dirname, "renderer/index.html");
const nativeBinary = app.isPackaged
  ? path.join(process.resourcesPath, "native/HuixiangBridge")
  : path.join(__dirname, "../native/bin/HuixiangBridge");
async function key() {
  if (sessionKey) return sessionKey;
  if (!store.data.encryptedKey) return "";
  try {
    const buffer = Buffer.from(store.data.encryptedKey, "base64");
    if (safeStorage.decryptStringAsync) {
      const decrypted = await safeStorage.decryptStringAsync(buffer);
      return typeof decrypted === "string" ? decrypted : decrypted.result;
    }
    return safeStorage.decryptString(buffer);
  } catch {
    throw new Error("无法解锁已保存的模型密钥，请在回复规则中重新填写");
  }
}
function safeIPC(name, fn) {
  ipcMain.handle(name, async (event, payload) => {
    try {
      if (
        event.sender !== window?.webContents ||
        event.senderFrame !== window.webContents.mainFrame ||
        fileURLToPath(event.senderFrame.url) !== uiFile
      )
        throw new Error("无效的操作来源");
      return { ok: true, data: await fn(payload) };
    } catch (e) {
      return { ok: false, error: e.message || "操作失败" };
    }
  });
}
function broadcast(state) {
  if (window && !window.isDestroyed())
    window.webContents.send("agent:state", state);
}
function createWindow() {
  window = new BrowserWindow({
    width: 1220,
    height: 830,
    minWidth: 920,
    minHeight: 680,
    backgroundColor: "#f5f7fa",
    title: "回响 · 微信接待助手",
    titleBarStyle: "hiddenInset",
    trafficLightPosition: { x: 18, y: 18 },
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    },
  });
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (e) => e.preventDefault());
  window.once("ready-to-show", () => window.show());
  window.loadFile(uiFile);
  window.on("close", () => agent?.stop("窗口关闭，接待已暂停"));
}
function register() {
  safeIPC("workspace:load", () => ({
    workspace: store.public(),
    agent: agent.state(),
    platform: process.platform,
    version: app.getVersion(),
  }));
  safeIPC("settings:save", (value) => {
    agent.stop("配置已更新，请重新开始接待");
    agent.draft = null;
    agent.latest = null;
    const result = store.settings(value);
    broadcast(agent.state());
    return result;
  });
  safeIPC("faq:save", (value) => {
    agent.stop("业务资料已更新，请重新开始接待");
    agent.draft = null;
    return store.faq(value);
  });
  safeIPC("faq:remove", (id) => {
    agent.stop("业务资料已更新，请重新开始接待");
    agent.draft = null;
    return store.removeFAQ(String(id));
  });
  safeIPC("native:permissions", () => native.request("permissions"));
  safeIPC("native:request-permission", (type) => {
    if (!["screen", "accessibility"].includes(type))
      throw new Error("未知的权限类型");
    return native.request("request-" + type);
  });
  safeIPC("native:windows", () => native.request("windows"));
  safeIPC("native:preview", async (id) => {
    if (agent.running || agent.busy) throw new Error("请先暂停接待再预览窗口");
    if (!Number.isSafeInteger(id) || id <= 0) throw new Error("窗口编号无效");
    return native.request("capture", { windowId: id });
  });
  safeIPC("agent:read", () => agent.read());
  safeIPC("agent:generate", () => agent.generate());
  safeIPC("agent:start", () => agent.start());
  safeIPC("agent:stop", () => {
    agent.stop("你已暂停接待");
    return agent.state();
  });
  safeIPC("agent:send", (value) => agent.send(value));
  safeIPC("model:save-key", async (value) => {
    const plain = String(value || "").trim();
    if (plain.length > 2000) throw new Error("密钥过长");
    sessionKey = plain;
    if (!plain) {
      store.data.encryptedKey = "";
      store.flush();
      return { persisted: true };
    }
    const available = safeStorage.isAsyncEncryptionAvailable
      ? await safeStorage.isAsyncEncryptionAvailable()
      : safeStorage.isEncryptionAvailable();
    if (!available) {
      store.data.encryptedKey = "";
      store.flush();
      return { persisted: false };
    }
    const encrypted = safeStorage.encryptStringAsync
      ? await safeStorage.encryptStringAsync(plain)
      : safeStorage.encryptString(plain);
    store.data.encryptedKey = Buffer.from(encrypted).toString("base64");
    store.flush();
    return { persisted: true };
  });
  safeIPC("model:test", () => agent.modelReply([], true));
  safeIPC("app:open-settings", (type) => {
    const targets = {
      screen:
        "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture",
      accessibility:
        "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility",
    };
    if (!targets[type]) throw new Error("未知的设置页面");
    return shell.openExternal(targets[type]);
  });
  safeIPC("app:data-folder", () => shell.openPath(store.dir));
}
app
  .whenReady()
  .then(() => {
    if (!single) return;
    try {
      store = new Store(path.join(app.getPath("userData"), "workspace"));
    } catch (e) {
      require("electron").dialog.showErrorBox("无法打开回响", e.message);
      app.quit();
      return;
    }
    native = new NativeBridge(nativeBinary);
    agent = new Agent({
      store,
      native,
      getKey: key,
      idleTime: () => powerMonitor.getSystemIdleTime(),
      notify: (state) => {
        broadcast(state);
        if (
          state.status.includes("需要你处理") ||
          state.status.includes("等待你确认")
        ) {
          if (Notification.isSupported())
            new Notification({
              title: "回响 · 有对话需要你",
              body: "请打开接待工作台查看。",
            }).show();
        }
      },
    });
    session.defaultSession.setPermissionRequestHandler(
      (_wc, _permission, callback) => callback(false),
    );
    session.defaultSession.setPermissionCheckHandler(() => false);
    register();
    createWindow();
    globalShortcut.register("CommandOrControl+Shift+.", () => {
      agent.stop("已通过快捷键紧急暂停");
      window?.show();
    });
    powerMonitor.on("lock-screen", () => agent.stop("电脑已锁屏，接待已暂停"));
    powerMonitor.on("suspend", () => agent.stop("电脑即将休眠，接待已暂停"));
    Menu.setApplicationMenu(
      Menu.buildFromTemplate([
        {
          label: "回响",
          submenu: [
            { role: "about" },
            { type: "separator" },
            {
              label: "暂停所有接待",
              accelerator: "CommandOrControl+Shift+.",
              click: () => agent.stop("你已暂停所有接待"),
            },
            { type: "separator" },
            { role: "hide" },
            { role: "quit" },
          ],
        },
        {
          label: "编辑",
          submenu: [
            { role: "undo" },
            { role: "redo" },
            { type: "separator" },
            { role: "cut" },
            { role: "copy" },
            { role: "paste" },
            { role: "selectAll" },
          ],
        },
        {
          label: "窗口",
          submenu: [{ role: "minimize" }, { role: "zoom" }, { role: "front" }],
        },
      ]),
    );
  })
  .catch((e) => {
    require("electron").dialog.showErrorBox("启动失败", e.message);
    app.quit();
  });
app.on("second-instance", () => {
  window?.show();
  window?.focus();
});
app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
app.on("will-quit", () => {
  agent?.stop();
  globalShortcut.unregisterAll();
});
