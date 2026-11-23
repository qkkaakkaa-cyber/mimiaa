const test = require("node:test"),
  assert = require("node:assert/strict"),
  fs = require("node:fs"),
  os = require("node:os"),
  path = require("node:path");
const { FleetAgent } = require("../app/lib/fleet-agent.cjs");
const { Store } = require("../app/lib/store.cjs");
const { DEFAULT_CALIBRATION } = require("../app/lib/domain.cjs");
const { groupAllowed, discoverFromAX } = require("../app/lib/discovery.cjs");
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
      { id: "session_item_甲", name: "甲", signature: "old", time: "01:00" },
      { id: "session_item_乙", name: "乙", signature: "old", time: "01:00" },
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
  f.native.control = { isWeChatActive: () => false };
  await f.agent.start();
  f.rows[0].signature = "new-while-working";
  await f.agent.tick();
  assert.deepEqual(f.sendNames, ["甲"]);
});
test("点进微信暂停处理，离开微信后保持接待并继续", async (t) => {
  const f = fixture(t);
  let active = false;
  f.native.backgroundCapable = true;
  f.native.control = { isWeChatActive: () => active };
  await f.agent.start();
  active = true;
  f.agent.setActivityPaused(true);
  f.rows[0].signature = "new-paused";
  await f.agent.tick();
  assert.deepEqual(f.sendNames, []);
  assert.equal(f.agent.running, true);
  active = false;
  f.agent.setActivityPaused(false);
  await f.agent.tick();
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
  await f.agent.start();
  f.agent.intelligence = workingModel;
  await f.agent.tick();
  assert.deepEqual(f.sendNames, ["甲"]);
  assert.deepEqual(f.store.data.modelRetries, {});
});
