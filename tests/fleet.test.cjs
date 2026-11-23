const test = require("node:test"),
  assert = require("node:assert/strict"),
  fs = require("node:fs"),
  os = require("node:os"),
  path = require("node:path");
const { FleetAgent } = require("../app/lib/fleet-agent.cjs");
const { Store } = require("../app/lib/store.cjs");
const { DEFAULT_CALIBRATION } = require("../app/lib/domain.cjs");
const { groupAllowed, discoverFromAX, isRecentWeChatTime } = require("../app/lib/discovery.cjs");
const context = (name) => ({
  sessionId: "session_item_" + name,
  expectedTitle: name,
  windowId: 1,
  kind: "private",
  calibration: DEFAULT_CALIBRATION,
});
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "huixiang-fleet-"));
  const store = new Store(dir);
  store.settings({
    ...store.data.settings,
    mode: "auto",
    model: { baseUrl: "https://api.moonshot.cn/v1", name: "kimi-k2.6" },
  });
  let rows = [
      { id: "session_item_甲", name: "甲", signature: "old", time: "" },
      { id: "session_item_乙", name: "乙", signature: "old", time: "" },
    ],
    active = context("甲");
  let sendNames = [];
  const native = {
    cancelSends() {},
    async request(cmd, p) {
      if (cmd === "permissions") return { accessibility: true, screen: true };
      if (cmd === "discover")
        return { sessions: structuredClone(rows), active };
      if (cmd === "select-session") {
        active = context(p.id.slice("session_item_".length));
        return { active };
      }
      if (cmd === "capture")
        return {
          width: 1000,
          height: 800,
          lines: [
            {
              text: active.expectedTitle,
              box: { x: 0.35, y: 0.03, w: 0.1, h: 0.03 },
            },
            { text: "你好", box: { x: 0.35, y: 0.3, w: 0.15, h: 0.04 } },
          ],
        };
      throw new Error("unexpected " + cmd);
    },
  };
  const agent = new FleetAgent({
    store,
    native,
    idleTime: () => 10,
    getKey: async () => "",
    notify() {},
  });
  agent.intelligence = () => ({
    async decide(messages, memory) {
      return {
        action: "ask",
        reply: "您想咨询什么服务？",
        reason: "澄清需求",
        sourceNames: [],
        summary: messages.at(-1).text,
        canAuto: true,
      };
    },
  });
  agent.deliver = async () => {
    sendNames.push(agent.context.expectedTitle);
    agent.draft = null;
    return { confirmed: true };
  };
  t.after(() => {
    agent.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return { store, agent, rows, sendNames, native };
}
test("启动自动发现列表，不补发旧消息；私聊之间自动轮询", async (t) => {
  const f = fixture(t);
  await f.agent.start();
  await f.agent.tick();
  assert.deepEqual(f.sendNames, []);
  f.rows[0].signature = "new-a";
  f.rows[1].signature = "new-b";
  await f.agent.tick();
  await f.agent.tick();
  assert.deepEqual(f.sendNames, ["甲", "乙"]);
  assert.ok(f.store.memoryFor("session_item_甲").messages.length);
  assert.equal(f.store.memoryFor("session_item_乙").summary, "你好");
});
test("开启时补今天仍未读的会话，略过之前日期和拍一拍", async (t) => {
  const f = fixture(t);
  Object.assign(f.rows[0], { unread: true, today: true });
  Object.assign(f.rows[1], { unread: true, today: false, time: "昨天 21:00" });
  f.rows.push({ id: "session_item_丙", name: "丙", signature: "nudge", unread: true, today: true, systemOnly: true });
  assert.equal((await f.agent.start()).queueSize, 1);
  await f.agent.tick();
  f.rows[0].unread = false;
  await f.agent.tick();
  assert.deepEqual(f.sendNames, ["甲"]);
});
test("排队期间用户已读，自动接待不再补发", async (t) => {
  const f = fixture(t);
  Object.assign(f.rows[0], { unread: true, today: true });
  await f.agent.start();
  f.rows[0].unread = false;
  await f.agent.tick();
  assert.deepEqual(f.sendNames, []);
});
test("核对最近十分钟已读私聊，只补回真实来信且同一预览只检查一次", async (t) => {
  const f = fixture(t);
  const time = new Date().toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
  for (const row of f.rows) Object.assign(row, { preview: "你好", time, today: true });
  const request = f.native.request;
  f.native.request = async (cmd, payload) => {
    const result = await request(cmd, payload);
    if (cmd === "capture" && f.agent.context.expectedTitle === "乙")
      result.lines.at(-1).outgoing = true;
    return result;
  };
  await f.agent.start();
  await f.agent.tick();
  await f.agent.tick();
  await f.agent.tick();
  assert.deepEqual(f.sendNames, ["甲"]);
});
test("拍一拍盖住预览时，只回答时间可核对的真实消息", async (t) => {
  const f = fixture(t);
  const time = new Date().toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
  for (const row of f.rows) Object.assign(row, { preview: "「对方」拍了拍我", time, today: true, systemOnly: true });
  const request = f.native.request;
  f.native.request = async (cmd, payload) => {
    const result = await request(cmd, payload);
    if (cmd === "capture") result.messageTime = f.agent.context.expectedTitle === "甲" ? time : "昨天";
    return result;
  };
  await f.agent.start();
  await f.agent.tick();
  await f.agent.tick();
  assert.deepEqual(f.sendNames, ["甲"]);
});
test("十分钟核对能跨午夜且排除旧日期和未来时间", () => {
  const now = new Date(2026, 10, 24, 0, 4, 31);
  assert.equal(isRecentWeChatTime("昨天 23:54", now), true);
  assert.equal(isRecentWeChatTime("昨天 23:53", now), false);
  assert.equal(isRecentWeChatTime("00:05", now), false);
  assert.equal(isRecentWeChatTime("今天 00:03", now), true);
});
test("主列表里已看不到的过期巡检项不再显示为待切换", async (t) => {
  const f = fixture(t);
  f.store.saveReception({
    enabled: true,
    pending: {
      session_item_列表外: {
        signature: "old-audit",
        queuedAt: Date.now() - 11 * 60 * 1000,
        recentAudit: true,
      },
    },
  });
  await f.agent.start();
  await f.agent.tick();
  assert.deepEqual(f.store.data.reception.pending, {});
  assert.match(f.agent.status, /等待新的/);
});
test("微信主列表不可见时等电脑空闲再恢复，恢复后继续巡检", async (t) => {
  const f = fixture(t);
  const request = f.native.request;
  let hidden = true, recoveries = 0, idle = 2;
  f.agent.idleTime = () => idle;
  f.native.request = async (cmd, payload) => {
    if (cmd === "discover" && hidden)
      throw new Error("请展开微信的聊天列表，微响会自动识别");
    return request(cmd, payload);
  };
  f.agent.recoverChatList = async () => {
    recoveries++;
    hidden = false;
  };
  await f.agent.start();
  await f.agent.tick();
  assert.equal(recoveries, 0);
  idle = 9;
  await f.agent.tick();
  assert.equal(recoveries, 1);
  f.rows[0].signature = "new-after-restore";
  await f.agent.tick();
  assert.deepEqual(f.sendNames, ["甲"]);
});
test("隐藏的微信每五分钟巡检，无消息后还原，有消息则先处理", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: new Date(2026, 10, 24, 9, 0) });
  const f = fixture(t);
  const request = f.native.request;
  let hidden = false, reveals = 0, parks = 0;
  const previousWindow = { pid: 100, hidden: true, minimized: false };
  f.native.request = async (cmd, payload) => {
    if (cmd === "discover" && hidden)
      throw new Error("请展开微信的聊天列表，微信主窗口已隐藏");
    return request(cmd, payload);
  };
  f.agent.recoverChatList = async () => {
    reveals++;
    hidden = false;
    return previousWindow;
  };
  f.agent.parkChatList = (window) => {
    assert.equal(window, previousWindow);
    parks++;
    hidden = true;
  };
  await f.agent.start();
  hidden = true;
  await f.agent.tick();
  t.mock.timers.tick(299999);
  await f.agent.tick();
  assert.equal(reveals, 0);
  t.mock.timers.tick(1);
  await f.agent.tick();
  assert.equal(reveals, 1);
  assert.equal(parks, 1);
  assert.equal(hidden, true);

  f.rows[0].signature = "arrived-while-hidden";
  t.mock.timers.tick(300000);
  await f.agent.tick();
  assert.equal(reveals, 2);
  assert.equal(parks, 1);
  assert.deepEqual(f.sendNames, ["甲"]);
  await f.agent.tick();
  assert.equal(parks, 2);
  assert.equal(hidden, true);
});
test("会话暂时无法取得焦点时，其他会话继续回复", async (t) => {
  const f = fixture(t);
  let failedSelections = 0;
  const request = f.native.request;
  await request("select-session", { id: "session_item_乙" });
  f.native.request = async (cmd, payload) => {
    if (cmd === "select-session" && payload.id === "session_item_甲") {
      failedSelections++;
      throw new Error("微信暂未取得窗口焦点");
    }
    return request(cmd, payload);
  };
  await f.agent.start();
  f.rows[0].signature = "new-but-unavailable";
  f.rows[1].signature = "new-and-open";
  await f.agent.tick();
  await f.agent.tick();
  f.rows[1].signature = "second-new-and-open";
  await f.agent.tick();
  assert.deepEqual(f.sendNames, ["乙", "乙"]);
  assert.equal(failedSelections, 1);
  assert.equal(f.agent.running, true);
  assert.equal(f.agent.queue.has("session_item_甲"), true);
});
test("需要人工的聊天进入待办，其他聊天继续处理", async (t) => {
  const f = fixture(t);
  f.agent.intelligence = () => ({
    async decide() {
      return {
        action: "handoff",
        reply: "请同事确认",
        reason: "需核对",
        sourceNames: [],
        summary: "",
        canAuto: false,
      };
    },
  });
  await f.agent.start();
  f.rows[0].signature = "new-a";
  f.rows[1].signature = "new-b";
  await f.agent.tick();
  await f.agent.tick();
  assert.equal(f.agent.tasks.length, 2);
  assert.equal(f.agent.running, true);
  assert.deepEqual(f.sendNames, []);
});
test("群聊触发范围及未知类型不会误回复", () => {
  const settings = {
    reception: {
      privateChats: true,
      groupChats: true,
      groupPolicy: "mentions",
      mentionName: "小明",
    },
  };
  assert.equal(
    groupAllowed({ kind: "group" }, { last: { text: "大家好" } }, settings),
    false,
  );
  assert.equal(
    groupAllowed(
      { kind: "group" },
      { last: { text: "@小明 请问周末营业吗" } },
      settings,
    ),
    true,
  );
  assert.equal(
    groupAllowed({ kind: "unknown" }, { last: { text: "@小明" } }, settings),
    false,
  );
  for (const oldMode of ["all", "questions"]) {
    settings.reception.groupPolicy = oldMode;
    for (const text of [
      "请问几点开门？",
      "@小明同学 你好",
      "abc@小明 你好",
      "@所有人 有问题吗？",
    ])
      assert.equal(
        groupAllowed({ kind: "group" }, { last: { text } }, settings),
        false,
      );
  }
  assert.equal(
    groupAllowed(
      { kind: "group" },
      { last: { text: "请教一下 @小明\u2005几点开门" } },
      settings,
    ),
    true,
  );
});
test("发现结构自动提取原生微信会话与输入位置，过滤系统会话", () => {
  const item = (id, value, x, y, w, h) => ({
    id,
    value,
    frame: { x, y, w, h },
  });
  const d = discoverFromAX({
    windowId: 8,
    pid: 1,
    frame: { x: 0, y: 0, w: 1000, h: 800 },
    items: [
      item("session_list", "", 60, 80, 250, 700),
      item("session_item_甲", "甲\n你好\n12:00", 60, 90, 250, 70),
      item("session_item_公众号", "公众号\n新闻\n12:00", 60, 160, 250, 70),
      item("session_item_折叠的聊天", "折叠的聊天\n[85条] 群消息", 60, 230, 250, 70),
      item("current_chat_name_label", "甲", 340, 20, 120, 30),
      item("chat_message_list", "", 310, 90, 680, 480),
      item("chat_input_field", "", 320, 620, 650, 130),
      item("voip_button", "语音通话", 900, 20, 30, 30),
    ],
  });
  assert.equal(d.sessions.length, 1);
  assert.equal(d.active.expectedTitle, "甲");
  assert.equal(d.active.kind, "private");
  assert.equal(d.active.windowId, 8);
});
test("新款微信的方括号计数、企业微信标题和最新图片可以同时识别", () => {
  const item = (id, value, x, y, w, h) => ({ id, value, frame: { x, y, w, h } });
  const raw = {
    windowId: 8,
    pid: 1,
    frame: { x: 0, y: 0, w: 1000, h: 800 },
    items: [
      item("session_list", "会话", 60, 80, 250, 700),
      item("session_item_周琴", "周琴\n[4条] \n[图片]\n08:23\n消息免打扰", 60, 90, 250, 70),
      item("big_title_line_h_view", "周琴 @悦瑞网络", 340, 20, 160, 30),
      item("chat_message_list", "", 310, 90, 680, 480),
      item("chat_input_field", "", 320, 620, 650, 130),
      item("voip_button", "语音通话", 900, 20, 30, 30),
      item("chat_bubble_item_view", "图片", 350, 350, 120, 100),
    ],
  };
  const d = discoverFromAX(raw);
  assert.equal(d.sessions[0].unreadCount, 4);
  assert.equal(d.sessions[0].today, true);
  assert.equal(d.sessions[0].preview, "[图片]");
  assert.equal(d.sessions[0].time, "08:23");
  assert.equal(d.active.sessionId, "session_item_周琴");
  assert.equal(d.active.kind, "private");
  assert.equal(d.messageLines.at(-1).mediaType, "image");
  raw.items[1].value = "周琴\n[图片]\n08:23\n消息免打扰";
  assert.equal(discoverFromAX(raw).sessions[0].signature, d.sessions[0].signature);
  raw.items[0].value = "折叠的聊天";
  assert.throws(() => discoverFromAX(raw), /不接待折叠会话/);
});
test("微信把成员数拆成独立控件时仍识别为群聊", () => {
  const item = (id, value, x, y, w, h) => ({
    id,
    value,
    frame: { x, y, w, h },
  });
  const view = discoverFromAX({
    windowId: 8,
    pid: 1,
    frame: { x: 0, y: 0, w: 1000, h: 800 },
    items: [
      item("session_list", "", 60, 80, 250, 700),
      item(
        "session_item_项目协作",
        "项目协作\n请问几点开门？\n12:00",
        60,
        90,
        250,
        70,
      ),
      item("big_title_line_h_view", "项目协作(480)", 340, 20, 160, 30),
      item("current_chat_name_label", "项目协作", 340, 20, 120, 30),
      item("current_chat_count_label", "(480)", 460, 20, 65, 30),
      item("chat_message_list", "", 310, 90, 680, 480),
      item("chat_input_field", "", 320, 620, 650, 130),
      item("voip_button", "语音通话", 900, 20, 30, 30),
    ],
  });
  assert.equal(view.active.kind, "group");
  assert.equal(
    groupAllowed(
      view.active,
      { last: { text: "请问几点开门？" } },
      { reception: { groupChats: true, mentionName: "小明" } },
    ),
    false,
  );
});
test("模型等待时取消接待，不会生成或发送过期方案", async (t) => {
  const f = fixture(t);
  let release, entered;
  const enteredPromise = new Promise((r) => (entered = r)),
    wait = new Promise((r) => (release = r));
  f.agent.intelligence = () => ({
    async decide() {
      entered();
      await wait;
      return { action: "ask", reply: "你好", sourceNames: [], canAuto: true };
    },
  });
  await f.agent.start();
  f.rows[0].signature = "new";
  const running = f.agent.tick();
  await enteredPromise;
  f.agent.stop();
  release();
  await running;
  assert.deepEqual(f.sendNames, []);
  assert.equal(f.agent.running, false);
});
test("在其他应用操作不会吞掉当前会话的新消息", async (t) => {
  const f = fixture(t);
  f.agent.idleTime = () => 0;
  f.native.backgroundCapable = true;
  f.native.control = { isWeChatInUse: () => false };
  await f.agent.start();
  f.rows[0].signature = "new-while-working";
  await f.agent.tick();
  assert.deepEqual(f.sendNames, ["甲"]);
});
test("微信操作时暂停，微信仍在前台但操作停止后继续", async (t) => {
  const f = fixture(t);
  let active = false;
  f.native.backgroundCapable = true;
  f.native.control = {
    isWeChatActive: () => true,
    isWeChatInUse: () => active,
  };
  await f.agent.start();
  active = true;
  f.agent.setActivityPaused(true);
  f.rows[0].signature = "new-paused";
  await f.agent.tick();
  assert.deepEqual(f.sendNames, []);
  assert.equal(f.agent.running, true);
  assert.equal(f.store.data.reception.pending[f.rows[0].id].signature, "new-paused");
  active = false;
  f.agent.setActivityPaused(false);
  await f.agent.tick();
  assert.deepEqual(f.sendNames, ["甲"]);
});
test("手写稿清空后，自动接待复核同一条消息并补回", async (t) => {
  const f = fixture(t);
  let draft = "自己的草稿";
  const request = f.native.request;
  f.native.request = async (cmd, payload) => {
    const result = await request(cmd, payload);
    return cmd === "discover" ? { ...result, composerText: draft } : result;
  };
  const deliver = f.agent.deliver;
  f.agent.deliver = (...args) => {
    if (draft) throw Object.assign(new Error("微信已有草稿"), { needsHuman: true });
    return deliver(...args);
  };
  await f.agent.start();
  f.rows[0].signature = "new-while-drafting";
  await f.agent.tick();
  assert.equal(f.agent.tasks.length, 1);
  assert.deepEqual(f.sendNames, []);
  draft = "";
  await f.agent.tick();
  assert.equal(f.agent.tasks.length, 0);
  assert.deepEqual(f.sendNames, ["甲"]);
});
test("手动提炼当前聊天只读取和保存核心，不发送微信消息", async (t) => {
  const f = fixture(t);
  f.agent.intelligence = () => ({
    summarize: async (messages) => {
      assert.equal(messages.at(-1).text, "你好");
      return {
        action: "wait",
        conversationFinished: false,
        conversationReport: {
          core: "互相打招呼",
          intent: "未明确",
          nextSteps: [],
          ownerTodo: [],
        },
      };
    },
  });
  const listing = await f.agent.summarySessions();
  assert.equal(listing.activeId, "session_item_甲");
  const result = await f.agent.summarizeCurrent("session_item_乙");
  assert.deepEqual(f.sendNames, []);
  assert.equal(f.store.reports()[0].core, "互相打招呼");
  assert.equal(f.store.reports()[0].title, "乙");
  assert.equal(f.agent.busy, false);
  assert.equal(result.busy, false);
});
test("AI 凭证暂时不可用，恢复接待后核对并处理同一条消息", async (t) => {
  const f = fixture(t);
  await f.agent.start();
  f.rows[0].signature = "new";
  const workingModel = f.agent.intelligence;
  f.agent.intelligence = () => ({
    decide: async () => {
      throw new Error("暂时无法读取凭证");
    },
  });
  await f.agent.tick();
  assert.equal(f.agent.running, true);
  assert.match(f.agent.status, /稍后自动重试/);
  assert.deepEqual(f.sendNames, []);
  const reopened = new Store(f.store.dir);
  const pending = reopened.data.reception.pending[f.rows[0].id];
  assert.ok(pending.retryFingerprint);
  assert.ok(pending.retryAfter > Date.now());
  assert.equal(Object.hasOwn(pending, "preview"), false);
  pending.retryAfter = 0;
  reopened.flush();
  f.agent.store = reopened;
  await f.agent.start();
  f.agent.intelligence = workingModel;
  await f.agent.tick();
  assert.deepEqual(f.sendNames, ["甲"]);
  assert.deepEqual(reopened.data.reception.pending, {});
});

test("切换后读取失败，保留已被打开的未读会话且继续处理其他会话", async (t) => {
  const f = fixture(t);
  Object.assign(f.rows[0], { unread: true, today: true, preview: "你好" });
  const request = f.native.request;
  let fail = true;
  f.native.request = async (cmd, payload) => {
    const result = await request(cmd, payload);
    if (cmd === "select-session" && payload.id === f.rows[0].id) f.rows[0].unread = false;
    if (cmd === "capture" && f.agent.context.expectedTitle === "甲" && fail)
      throw new Error("微信暂未显示聊天内容");
    return result;
  };
  await f.agent.start();
  await f.agent.tick();
  assert.equal(f.agent.running, true);
  assert.equal(f.store.data.reception.pending[f.rows[0].id].opened, true);
  f.rows[1].signature = "new";
  await f.agent.tick();
  assert.deepEqual(f.sendNames, ["乙"]);
  fail = false;
  f.agent.queue.get(f.rows[0].id).retryAfter = 0;
  await f.agent.tick();
  assert.deepEqual(f.sendNames, ["乙", "甲"]);
});

test("限流超过三次仍保留待回复，限流期间继续发现新消息", async (t) => {
  const f = fixture(t);
  const workingModel = f.agent.intelligence;
  await f.agent.start();
  let calls = 0;
  f.rows[0].signature = "rate-limited";
  f.agent.intelligence = () => ({ decide: async () => {
    calls++;
    throw Object.assign(new Error("AI 接口限流"), { rateLimited: true, retryDelay: 45000 });
  } });
  await f.agent.tick();
  f.rows[1].signature = "arrived-during-rate-limit";
  await f.agent.tick();
  assert.equal(calls, 1);
  assert.equal(Object.keys(f.store.data.reception.pending).length, 2);
  for (let retry = 0; retry < 3; retry++) {
    f.store.data.reception.modelBlockedUntil = 0;
    f.agent.queue.get(f.rows[0].id).retryAfter = 0;
    await f.agent.tick();
  }
  assert.equal(calls, 4);
  assert.equal(f.agent.running, true);
  assert.deepEqual(f.sendNames, []);
  f.agent.intelligence = workingModel;
  f.store.data.reception.modelBlockedUntil = 0;
  f.agent.queue.get(f.rows[0].id).retryAfter = 0;
  await f.agent.tick();
  await f.agent.tick();
  assert.deepEqual(f.sendNames, ["甲", "乙"]);
});

test("单段发送结果不明时保留人工待办，自动接待仍处理下一段", async (t) => {
  const f = fixture(t);
  const sendNext = f.agent.deliver;
  const request = f.native.request;
  let uncertainAttempts = 0;
  f.native.request = async (cmd, payload) => {
    if (cmd === "send") {
      uncertainAttempts++;
      throw new Error("微信发送确认中断");
    }
    return request(cmd, payload);
  };
  f.agent.deliver = async (...args) => f.agent.context.expectedTitle === "甲"
    ? FleetAgent.prototype.deliver.call(f.agent, ...args) : sendNext(...args);
  await f.agent.start();
  f.rows[0].signature = "uncertain";
  f.rows[1].signature = "second";
  await f.agent.tick();
  assert.equal(f.agent.running, true);
  assert.equal(f.agent.tasks[0].context.expectedTitle, "甲");
  assert.equal(f.store.data.ledger[0].status, "unconfirmed");
  await f.agent.tick();
  f.rows[0].signature = "uncertain-reappeared";
  await f.agent.tick();
  assert.deepEqual(f.sendNames, ["乙"]);
  assert.equal(uncertainAttempts, 1);
});
