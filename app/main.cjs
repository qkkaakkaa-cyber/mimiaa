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
  systemPreferences,
  dialog,
  nativeImage,
  clipboard,
} = require("electron");
const path = require("node:path");
const fs = require("node:fs");
const { fileURLToPath } = require("node:url");
const { Store } = require("./lib/store.cjs");
const { NativeBridge } = require("./lib/native.cjs");
const { FleetAgent: Agent } = require("./lib/fleet-agent.cjs");
const { MacControlBridge } = require("./lib/mac-control.cjs");
const {
  importProvider,
  referencedProviderKey,
} = require("./lib/provider-import.cjs");
const { validateEndpoint } = require("./lib/domain.cjs");
const { readBusinessDocument } = require("./lib/documents.cjs");
const { WeChatTools } = require("./lib/wechat-tools.cjs");
const defaultAIModel = {
  baseUrl: "https://api.moonshot.cn/v1",
  name: "kimi-k3.1-pro",
  visionName: "kimi-k3.1-pro",
};
// Keep the original Electron identity for the existing data and encrypted key.
app.setName("回响");
const single = app.requestSingleInstanceLock();
if (!single) app.quit();
let window,
  store,
  agent,
  native,
  wechatTools,
  sessionKey = "",
  sessionKeyBase = "";
const uiFile = path.join(__dirname, "renderer/index.html");
const nativeBinary = app.isPackaged
  ? path.join(process.resourcesPath, "native/HuixiangBridge")
  : path.join(__dirname, "../native/bin/HuixiangBridge");
function providerReferenceFile() {
  return path.join(store.dir, "provider-source.json");
}
async function key(base) {
  if (sessionKey && sessionKeyBase === base) return sessionKey;
  if (fs.existsSync(providerReferenceFile())) {
    try {
      const sourcedKey = referencedProviderKey(providerReferenceFile(), base);
      if (sourcedKey) return sourcedKey;
    } catch {
      // The original config may have moved. The encrypted credential can
      // still be used independently of that file.
    }
  }
  if (!store.data.encryptedKey) return "";
  if (store.data.encryptedKeyBase && store.data.encryptedKeyBase !== base)
    return "";
  try {
    const buffer = Buffer.from(store.data.encryptedKey, "base64");
    if (safeStorage.decryptStringAsync) {
      let timer;
      try {
        const decrypted = await Promise.race([
          safeStorage.decryptStringAsync(buffer),
          new Promise((_, reject) => {
            timer = setTimeout(
              () => reject(new Error("模型凭证解锁超时")),
              15000,
            );
          }),
        ]);
        sessionKey =
          typeof decrypted === "string" ? decrypted : decrypted.result;
        sessionKeyBase = base;
        return sessionKey;
      } finally {
        clearTimeout(timer);
      }
    }
    sessionKey = safeStorage.decryptString(buffer);
    sessionKeyBase = base;
    return sessionKey;
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
    width: 500,
    height: 790,
    minWidth: 420,
    minHeight: 580,
    backgroundColor: "#f5f7fa",
    title: "微响 · 微信接待助手",
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
  safeIPC("wechat-tools:load", () => store.data.wechatRecords);
  safeIPC("wechat-tools:settings", (value) =>
    store.settings({ ...store.data.settings, wechatTools: value }),
  );
  safeIPC("wechat-tools:profile", () => wechatTools.readProfile());
  safeIPC("wechat-tools:learn-profile", () => wechatTools.learnProfile());
  safeIPC("wechat-tools:contacts", () => wechatTools.openContacts());
  safeIPC("wechat-tools:chats", () => wechatTools.openChats());
  safeIPC("wechat-tools:feed", async () => {
    await wechatTools.openMoments();
  });
  safeIPC("wechat-tools:scan", () => wechatTools.scanMoments());
  safeIPC("wechat-tools:editor", (value) =>
    wechatTools.openEditor({
      text: value?.text,
      kind: value?.kind === "media" ? "media" : "text",
    }),
  );
  safeIPC("wechat-tools:copy", (text) =>
    clipboard.writeText(String(text || "").slice(0, 1500)),
  );
  safeIPC("workspace:load", () => ({
    workspace: store.public(),
    agent: agent.state(),
    platform: process.platform,
    version: app.getVersion(),
  }));
  safeIPC("settings:save", (value) => {
    if (
      value.away?.enabled &&
      (!store.data.settings.away?.enabled || !value.away.sessionId)
    )
      value.away.sessionId = require("node:crypto").randomUUID();
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
  safeIPC("knowledge:import", async () => {
    const selected = await dialog.showOpenDialog(window, {
      title: "导入业务资料",
      properties: ["openFile"],
      filters: [{ name: "业务文档", extensions: ["txt", "md", "pdf", "docx"] }],
    });
    if (selected.canceled) return store.public();
    const value = await readBusinessDocument(
      selected.filePaths[0],
      new NativeBridge(nativeBinary),
    );
    agent.stop("业务资料已更新，请重新开始接待");
    agent.draft = null;
    return store.document(value);
  });
  safeIPC("knowledge:remove", (id) => {
    agent.stop("业务资料已更新，请重新开始接待");
    return store.removeDocument(String(id));
  });
  safeIPC("agent:practice", async (value) => {
    const messages = (Array.isArray(value) ? value : [])
      .slice(-20)
      .filter(
        (m) => ["in", "out"].includes(m.role) && typeof m.text === "string",
      )
      .map((m) => ({ role: m.role, text: m.text.trim().slice(0, 3000) }));
    if (
      !messages.length ||
      messages.at(-1).role !== "in" ||
      !messages.at(-1).text
    )
      throw new Error("先写一条客户咨询");
    return agent.intelligence().decide(messages, {});
  });
  safeIPC("native:smart-layout", async (id) => {
    if (agent.running || agent.busy) throw new Error("先暂停接待，再识别窗口");
    if (!Number.isSafeInteger(id) || id <= 0) throw new Error("先选择微信窗口");
    const capture = await native.request("capture", { windowId: id });
    return { capture, ...(await agent.intelligence().layout(capture)) };
  });
  safeIPC("agent:discover", () => agent.discover());
  safeIPC("agent:summary-sessions", () => agent.summarySessions());
  safeIPC("agent:summarize-current", (id) =>
    agent.summarizeCurrent(typeof id === "string" ? id.slice(0, 500) : ""),
  );
  safeIPC("agent:review-task", (id) => agent.reviewTask(String(id)));
  safeIPC("agent:retry-current", (value) =>
    agent.retryCurrent(
      value && typeof value === "object"
        ? {
            confirmedPrepared: value.confirmedPrepared === true,
            expectedTitle: String(value.expectedTitle || "").slice(0, 100),
          }
        : {},
    ),
  );
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
  safeIPC("agent:start", async () => {
    try {
      return await agent.start();
    } catch (error) {
      agent.stop(error.message);
      throw error;
    }
  });
  safeIPC("agent:stop", () => {
    agent.stop("你已暂停接待");
    return agent.state();
  });
  safeIPC("agent:send", (value) => agent.send(value));
  safeIPC("model:save-key", async (value) => {
    const plain = String(value || "").trim();
    if (plain.length > 2000) throw new Error("密钥过长");
    const model = store.data.settings.model;
    if (plain && (!model.baseUrl || !model.name))
      store.settings({ ...store.data.settings, model: defaultAIModel });
    sessionKey = plain;
    sessionKeyBase = store.data.settings.model.baseUrl
      ? validateEndpoint(store.data.settings.model.baseUrl)
      : "";
    fs.rmSync(providerReferenceFile(), { force: true });
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
    store.data.encryptedKeyBase = sessionKeyBase;
    store.flush();
    return { persisted: true };
  });
  safeIPC("model:test", () => agent.modelReply([], true));
  safeIPC("model:get-key", () =>
    shell.openExternal("https://platform.kimi.com/console/api-keys"),
  );
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
  .then(async () => {
    if (!single) return;
    try {
      store = new Store(path.join(app.getPath("userData"), "workspace"));
    } catch (e) {
      require("electron").dialog.showErrorBox("无法打开微响", e.message);
      app.quit();
      return;
    }
    try {
      const imported = await importProvider({
        file: path.join(store.dir, "provider-import.json"),
        store,
        safeStorage,
      });
      if (imported) {
        sessionKey = imported.key;
        sessionKeyBase = validateEndpoint(store.data.settings.model.baseUrl);
      }
    } catch (error) {
      store.log("warning", "AI 接口自动配置未完成，请检查模型设置。");
    }
    const controlPath = app.isPackaged
      ? path.join(process.resourcesPath, "native/MacControl.node")
      : path.join(__dirname, "../native/bin/MacControl.node");
    native = new MacControlBridge({
      helper: new NativeBridge(nativeBinary),
      control: require(controlPath),
      preferences: systemPreferences,
      idleTime: () => powerMonitor.getSystemIdleTime(),
    });
    wechatTools = new WeChatTools({
      native,
      store,
      cropAvatar: (shot, window, avatar) => {
        const scaleX = shot.width / window.w,
          scaleY = shot.height / window.h;
        const rect = {
          x: Math.round((avatar.x - window.x) * scaleX),
          y: Math.round((avatar.y - window.y) * scaleY),
          width: Math.round(avatar.w * scaleX),
          height: Math.round(avatar.h * scaleY),
        };
        if (
          rect.x < 0 ||
          rect.y < 0 ||
          rect.width < 4 ||
          rect.height < 4 ||
          rect.x + rect.width > shot.width ||
          rect.y + rect.height > shot.height
        )
          return "";
        return nativeImage
          .createFromBuffer(Buffer.from(shot.image, "base64"))
          .crop(rect)
          .resize({ width: 100 })
          .toDataURL();
      },
    });
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
              title: "微响 · 有对话需要你",
              body: "请打开接待工作台查看。",
            }).show();
        }
      },
    });
    agent.scanIdleMoments = () => {
      try {
        wechatTools.scanIdle();
      } catch {
        /* Chat reception continues if the feed is unavailable. */
      }
    };
    agent.learnContact = (contact, messages) =>
      wechatTools.learnFromSnapshot(contact, messages);
    agent.openChatsForSummary = () => wechatTools.openChatsForSummary();
    const activityPoll = setInterval(() => {
      try {
        if (!native.navigating)
          agent.setActivityPaused(native.control.isWeChatActive());
      } catch {}
    }, 500);
    activityPoll.unref();
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
          label: "微响",
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
