const test = require("node:test");
const assert = require("node:assert/strict");
const { MacControlBridge } = require("../app/lib/mac-control.cjs");
const { DEFAULT_CALIBRATION } = require("../app/lib/domain.cjs");
const line = (text, x, y) => ({
  text,
  confidence: 0.99,
  box: { x, y, w: 0.15, h: 0.025 },
});
function fixture() {
  const calls = [];
  const capture = {
    width: 1000,
    height: 800,
    window: { frame: { h: 800, w: 1000, x: 20, y: 40 }, pid: 123 },
    lines: [line("客户甲", 0.4, 0.04), line("你好", 0.35, 0.3)],
  };
  let typed = "";
  const control = {
    isTrusted: () => true,
    focus: (p) => calls.push(["focus", p]),
    clickInput: (p) => calls.push(["click", p]),
    typeChunk: (p) => {
      typed += p.text;
      calls.push(["type", p]);
    },
    commit: (p) => calls.push(["commit", p]),
  };
  const helper = {
    request: async (cmd) => {
      calls.push(["helper", cmd]);
      if (cmd === "permissions") return { screen: true, accessibility: false };
      if (cmd === "capture") {
        const next = structuredClone(capture);
        if (typed) next.lines.push(line(typed, 0.4, 0.84));
        return next;
      }
      throw new Error("unexpected helper command: " + cmd);
    },
  };
  const bridge = new MacControlBridge({
    helper,
    control,
    preferences: { isTrustedAccessibilityClient: () => true },
    idleTime: () => 10,
    sleep: async () => {},
  });
  const payload = {
    windowId: 42,
    expectedTitle: "客户甲",
    calibration: structuredClone(DEFAULT_CALIBRATION),
    text: "您好",
    expectedOCR: ["你好"],
    width: 1000,
    height: 800,
  };
  return { bridge, helper, control, capture, payload, calls };
}
test("权限显示使用实际执行键鼠操作的微响进程，不使用子进程的 AX 状态", async () => {
  const { bridge } = fixture();
  const status = await bridge.request("permissions");
  assert.equal(status.accessibility, true);
  assert.equal(status.screen, true);
  assert.equal(status.permissionOwner, "微响");
});
test("主进程未授权时不能把子进程的授权当成可用", async () => {
  const { bridge, control, helper } = fixture();
  control.isTrusted = () => false;
  helper.request = async () => ({ screen: true, accessibility: true });
  assert.equal((await bridge.request("permissions")).accessibility, false);
});
test("未授权时拒绝发送，不执行任何输入", async () => {
  const { bridge, control, payload, calls } = fixture();
  control.isTrusted = () => false;
  await assert.rejects(
    () => bridge.request("send", payload),
    /尚未获得辅助功能/,
  );
  assert.equal(calls.length, 0);
});
test("发送在主进程执行，子进程仅截图，且不受 JSON 属性顺序影响", async () => {
  const { bridge, payload, calls } = fixture();
  await bridge.request("send", payload);
  assert.deepEqual(
    calls.filter((c) => c[0] !== "helper").map((c) => c[0]),
    ["focus", "click", "type", "commit"],
  );
  assert.ok(
    calls.filter((c) => c[0] === "helper").every((c) => c[1] === "capture"),
  );
});
test("新消息出现时阻止输入和发送", async () => {
  const { bridge, payload, capture, calls } = fixture();
  capture.lines.push(line("先等等", 0.35, 0.5));
  await assert.rejects(
    () => bridge.request("send", payload),
    /客户消息发生变化/,
  );
  assert.ok(!calls.some((c) => c[0] === "type" || c[0] === "commit"));
});
test("微信已有草稿时不覆盖", async () => {
  const { bridge, payload, capture, calls } = fixture();
  capture.lines.push(line("用户正在写的内容", 0.4, 0.84));
  await assert.rejects(() => bridge.request("send", payload), /已有内容/);
  assert.ok(!calls.some((c) => c[0] === "type" || c[0] === "commit"));
});
test("紧急暂停能够中断主进程的分阶段发送", async () => {
  const { bridge, payload, calls } = fixture();
  bridge.sleep = async () => bridge.cancelSends();
  await assert.rejects(() => bridge.request("send", payload), /已暂停/);
  assert.ok(!calls.some((c) => c[0] === "type" || c[0] === "commit"));
});
test("输入未读回确认前不会按下发送键", async () => {
  const { bridge, control, payload, calls } = fixture();
  control.typeChunk = () => {};
  await assert.rejects(() => bridge.request("send", payload), /未能确认输入框/);
  assert.ok(!calls.some((c) => c[0] === "commit"));
});
test("不会拆开 emoji 的 UTF16 代理对", async () => {
  const { bridge, payload, calls } = fixture();
  payload.text = "欢迎咨询您好欢迎咨询您好欢迎😀咨询";
  await bridge.request("send", payload);
  for (const [, p] of calls.filter((c) => c[0] === "type")) {
    assert.ok(p.text.length <= 16);
    assert.doesNotMatch(p.text, /^[\udc00-\udfff]|[\ud800-\udbff]$/u);
  }
});
test("在其他应用打字时，后台发送不激活微信或注入全局按键", async () => {
  const { bridge, control, payload, calls } = fixture();
  bridge.backgroundCapable = true;
  bridge.idleTime = () => 0;
  control.isWeChatInUse = () => false;
  control.setComposer = (p) => control.typeChunk(p);
  control.pressSend = (p) => calls.push(["ax-send", p]);
  await bridge.request("send", { ...payload, automatic: true });
  assert.ok(calls.some((c) => c[0] === "ax-send"));
  assert.ok(!calls.some((c) => ["focus", "click", "commit"].includes(c[0])));
});
test("用户正在微信操作时，后台发送保留草稿而不抢输入", async () => {
  const { bridge, control, payload, calls } = fixture();
  bridge.backgroundCapable = true;
  bridge.idleTime = () => 0;
  control.isWeChatInUse = () => true;
  control.setComposer = () => calls.push(["set"]);
  control.pressSend = () => calls.push(["send"]);
  await assert.rejects(
    () => bridge.request("send", { ...payload, automatic: true }),
    /操作微信/,
  );
  assert.ok(
    !calls.some((c) => ["set", "send", "focus", "click"].includes(c[0])),
  );
});
test("点击发送前微信重新被操作，保留草稿并允许稍后继续", async () => {
  const { bridge, control, payload, calls } = fixture();
  bridge.backgroundCapable = true;
  control.isWeChatInUse = () => false;
  control.setComposer = (params) => control.typeChunk(params);
  control.pressSend = () => {
    throw new Error("你正在使用微信，自动暂停");
  };
  await assert.rejects(
    () => bridge.request("send", { ...payload, automatic: true }),
    { sendAttempted: false, inputPrepared: true, canRetry: true },
  );
  assert.ok(calls.some(([action]) => action === "type"));
});
test("时间标签变化不会被当成客户正文变化而取消发送", async () => {
  const { bridge, payload, capture } = fixture();
  capture.lines.push(line("12:00", 0.45, 0.2));
  payload.expectedFingerprint = require("../app/lib/domain.cjs").parseSnapshot(
    capture,
    { expectedTitle: payload.expectedTitle, calibration: payload.calibration },
  ).fingerprint;
  await bridge.request("send", payload);
});
test("自动切换会话期间跳过自己的前台变化，并在无人工干预时恢复原应用", async () => {
  const item = (id, value, x, y, w, h) => ({
    id,
    value,
    frame: { x, y, w, h },
  });
  let selected = "甲",
    restored = false,
    userTookOver = false,
    windowX = 0,
    front = 99,
    bridge;
  const raw = () => ({
    windowId: 8,
    pid: 1,
    frame: { x: windowX, y: 0, w: 1000, h: 800 },
    items: [
      item("session_list", "", 60, 80, 250, 700),
      item("session_item_甲", "甲\n你好\n12:00", 60, 90, 250, 70),
      item("session_item_乙", "乙\n找你\n12:00", 60, 160, 250, 70),
      item("current_chat_name_label", selected, 340, 20, 120, 30),
      item("chat_message_list", "", 310, 90, 680, 480),
      item("chat_input_field", "", 320, 620, 650, 130),
      item("voip_button", "语音通话", 900, 20, 30, 30),
    ],
  });
  const control = {
    inspect: () => JSON.stringify(raw()),
    isWeChatInUse: () => userTookOver,
    frontmostPID: () => front,
    focus: () => {
      assert.equal(bridge.navigating, true);
      front = 1;
    },
    clickInput: () => {
      selected = "乙";
    },
    restoreFocus: ({ pid }) => {
      assert.equal(pid, 99);
      restored = true;
      front = pid;
    },
  };
  bridge = new MacControlBridge({
    control,
    idleTime: () => 10,
    sleep: async () => {},
  });
  const row = (await bridge.request("discover")).sessions.find(
    (r) => r.name === "乙",
  );
  const result = await bridge.request("select-session", row);
  assert.equal(result.active.expectedTitle, "乙");
  assert.equal(restored, true);
  assert.equal(bridge.navigating, false);

  selected = "甲";
  restored = false;
  bridge.sleep = async () => { userTookOver = true; };
  await assert.rejects(() => bridge.request("select-session", row), /正在使用微信/);
  assert.equal(selected, "甲");
  assert.equal(restored, false);
  assert.equal(bridge.navigating, false);

  userTookOver = false;
  front = 99;
  bridge.sleep = async () => {};
  control.selectChatRow = ({ id }) => {
    assert.equal(id, row.id);
    selected = "乙";
  };
  control.focus = () => assert.fail("选中后台会话后无需切换前台");
  const background = await bridge.request("select-session", row);
  assert.equal(background.active.expectedTitle, "乙");
  assert.equal(front, 99);

  selected = "甲";
  let elapsed = 0;
  control.selectChatRow = () => {};
  bridge.sleep = async (ms) => {
    elapsed += ms;
    if (elapsed >= 800) selected = "乙";
  };
  const delayed = await bridge.request("select-session", row);
  assert.equal(delayed.active.expectedTitle, "乙");
  assert.equal(front, 99);

  selected = "甲";
  restored = false;
  control.selectChatRow = () => { throw new Error("后台选择暂不可用"); };
  control.focus = () => { front = 1; };
  bridge.sleep = async () => {};
  const fallback = await bridge.request("select-session", row);
  assert.equal(fallback.active.expectedTitle, "乙");
  assert.equal(restored, true);

  selected = "甲";
  control.selectChatRow = () => {};
  control.clickChatRow = ({ id }) => {
    assert.equal(id, row.id);
    selected = "乙";
  };
  control.focus = () => assert.fail("进程内点击已经成功，不需要前置微信");
  assert.equal((await bridge.request("select-session", row)).active.expectedTitle, "乙");
  assert.equal(front, 99);

  selected = "甲";
  restored = false;
  control.clickChatRow = () => {};
  control.focus = () => {};
  let workspaceRequests = 0;
  control.requestWorkspaceFocus = ({ pid }) => {
    assert.equal(pid, 1);
    workspaceRequests++;
    front = pid;
    windowX = 24;
  };
  let afterClick = null;
  let ownClickSampled = false;
  bridge.sleep = async (duration) => {
    if (afterClick !== null) afterClick += duration;
  };
  control.isWeChatInUse = () => {
    if (afterClick === null) return false;
    if (afterClick < 1000) ownClickSampled = true;
    return !ownClickSampled;
  };
  control.clickInput = ({ frame }) => {
    assert.equal(frame.x, 24);
    selected = "乙";
    afterClick = 0;
  };
  const workspaceFallback = await bridge.request("select-session", row);
  assert.equal(workspaceFallback.active.expectedTitle, "乙");
  assert.equal(workspaceRequests, 1);
  assert.equal(ownClickSampled, true);
  assert.equal(restored, true);
});
