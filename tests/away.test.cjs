const test = require("node:test"),
  assert = require("node:assert/strict"),
  fs = require("node:fs"),
  os = require("node:os"),
  path = require("node:path");
const { Store } = require("../app/lib/store.cjs"),
  { FleetAgent } = require("../app/lib/fleet-agent.cjs"),
  { Intelligence, validateDecision } = require("../app/lib/intelligence.cjs"),
  { DEFAULT_SETTINGS } = require("../app/lib/domain.cjs");
test("睡觉代班每段聊天只开场一次，重新开启为新会话", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "huixiang-away-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = new Store(dir);
  store.settings({
    ...store.data.settings,
    mode: "auto",
    away: { enabled: true, sessionId: "sleep-1" },
  });
  const agent = new FleetAgent({
    store,
    native: { cancelSends() {} },
    notify() {},
    getKey: async () => "",
  });
  agent.context = { sessionId: "session_item_A", expectedTitle: "A" };
  agent.intelligence = () => ({
    decide: async (_messages, _memory, options) => {
      assert.equal(options.firstIntro, true);
      return {
        action: "chat",
        reply: "你好，我是他的 AI 助理。你找他是有什么事儿？",
        reason: "自然开场",
        sourceNames: [],
        canAuto: true,
      };
    },
  });
  const snapshot = {
    last: { role: "in", text: "在吗" },
    messages: [{ role: "in", text: "在吗" }],
  };
  const first = await agent.planSnapshot(snapshot, agent.epoch);
  assert.equal(first.kind, "auto");
  assert.ok(first.text.includes("我是他的 AI 助理"));
  assert.ok(first.text.includes("你找他是有什么事儿"));
  store.markAwayGreeting(first.awayGreetingKey);
  assert.equal(new Store(dir).hasAwayGreeting(first.awayGreetingKey), true);
  assert.equal(
    store.hasAwayGreeting(store.awayGreetingKey("sleep-2", "session_item_A")),
    false,
  );
  assert.equal(
    store.hasAwayGreeting(store.awayGreetingKey("sleep-1", "session_item_B")),
    false,
  );
});
test("纯闲聊只调用一次对话模型，不检索业务资料", async () => {
  let calls = 0;
  const data = {
    settings: {
      ...DEFAULT_SETTINGS,
      identity: { name: "狗子", signReplies: true },
      away: { enabled: true },
      model: { baseUrl: "https://api.moonshot.cn/v1", name: "kimi-k2.6" },
    },
    get faqs() {
      throw new Error("闲聊不读业务问答");
    },
    get documents() {
      throw new Error("闲聊不读业务文档");
    },
  };
  const ai = new Intelligence({
    data,
    getKey: async () => "test-key",
    fetchImpl: async (url, options) => {
      calls++;
      assert.ok(url.endsWith("/chat/completions"));
      const body = JSON.parse(options.body);
      assert.ok(body.messages[0].content.includes("不检索业务资料"));
      assert.match(body.messages[0].content, /我是狗子，老板的 AI 助手/);
      assert.deepEqual(body.messages[1], { role: "assistant", content: "可以呀" });
      assert.deepEqual(body.messages[2], { role: "user", content: "你是谁？" });
      return {
        ok: true,
        json: async () => ({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  action: "chat",
                  reply: "我是狗子，老板的 AI 助手。 · 狗子",
                  reason: "自然接话",
                  sourceIds: [],
                  customerSummary: "",
                }),
              },
            },
          ],
        }),
      };
    },
  });
  const result = await ai.decide(
    [{ role: "in", text: "你是谁？" }],
    { messages: [{ role: "out", text: "可以呀 · 狗子" }] },
  );
  assert.equal(calls, 1);
  assert.equal(result.canAuto, true);
  assert.equal(result.reply, "我是狗子，老板的 AI 助手。");
});
test("普通接待模式不能用无来源闲聊动作绕过依据校验", () => {
  assert.throws(() =>
    validateDecision(
      { action: "chat", reply: "随便编业务" },
      [],
      DEFAULT_SETTINGS,
      "",
    ),
  );
});
test("闲聊保留自然接话和第一个问题，去掉连着追问", () => {
  const result = validateDecision(
    { action: "chat", reply: "练手很适合从小工具开始。你现在在做什么？要帮老板也做一个吗？" },
    [],
    { ...DEFAULT_SETTINGS, away: { enabled: true } },
    "想多练几天",
  );
  assert.equal(result.reply, "练手很适合从小工具开始。你现在在做什么？");
});
test("闲聊结束可以给对方确认摘要并记录核心事项", () => {
  const result = validateDecision(
    {
      action: "wrapup",
      reply: "好，我记下了，等老板醒了提醒他查看。",
      sourceIds: [],
      customerSummary: "想了解班车",
      closingSummary: "咨询班车，等待老板回复",
    },
    [],
    { ...DEFAULT_SETTINGS, away: { enabled: true } },
    "好的先这样，拜拜",
  );
  assert.equal(result.canAuto, true);
  assert.equal(result.closingSummary, "咨询班车，等待老板回复");
});
