const test = require("node:test"),
  assert = require("node:assert/strict"),
  fs = require("node:fs"),
  os = require("node:os"),
  path = require("node:path");
const { Store } = require("../app/lib/store.cjs");
test("对话核心按联系人和轮次归档，重启后保留，敏感内容脱敏", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "huixiang-reports-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = new Store(dir);
  const context = (name) => ({
    sessionId: name,
    expectedTitle: name,
    kind: "private",
  });
  const decision = {
    action: "chat",
    conversationReport: {
      core: "咨询曼谷翻译岗位",
      intent: "找翻译工作",
      nextSteps: ["补充到岗时间"],
      ownerTodo: ["确认岗位仍在招聘"],
    },
  };
  store.conversationReport(context("A"), { fingerprint: "1" }, decision);
  store.conversationReport(
    context("B"),
    { fingerprint: "2" },
    {
      action: "wrapup",
      conversationReport: {
        core: "闲聊旅行",
        intent: "随便聊聊",
        nextSteps: [],
        ownerTodo: [],
      },
    },
  );
  store.conversationReport(
    context("A"),
    { fingerprint: "3" },
    { ...decision, action: "wrapup" },
  );
  assert.equal(store.reports().length, 2);
  assert.equal(store.reports().find((r) => r.title === "A").finished, true);
  assert.deepEqual(store.reports().find((r) => r.title === "B").ownerTodo, []);
  store.conversationReport(
    context("A"),
    { fingerprint: "4" },
    {
      ...decision,
      conversationReport: {
        ...decision.conversationReport,
        core: "验证码：123456",
      },
    },
  );
  const reports = new Store(dir).reports();
  assert.equal(reports.length, 3);
  assert.equal(reports[0].finished, false);
  assert.equal(reports[0].core.includes("123456"), false);
  assert.equal(store.public().conversationReports, undefined);
});
test("今日名单按私聊联系人去重，群聊另计，回复仅计确认发送", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "huixiang-insight-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = new Store(dir),
    one = { sessionId: "A", expectedTitle: "甲", kind: "private" },
    group = { sessionId: "G", expectedTitle: "工作群", kind: "group" },
    snapshot = { fingerprint: "first" };
  store.insight("in", one, snapshot);
  store.insight("in", one, snapshot);
  store.insight("in", group, snapshot);
  let report = store.overview();
  assert.equal(report.privateCount, 1);
  assert.equal(report.groupCount, 1);
  assert.equal(report.repliesCount, 0);
  store.insight("sent", one, snapshot, "询问班车，需要老板回复", true);
  store.insight("sent", one, snapshot);
  report = new Store(dir).overview();
  assert.equal(report.repliesCount, 1);
  assert.equal(report.items.find((i) => i.title === "甲").finished, true);
  assert.equal(
    report.items.find((i) => i.title === "甲").summary,
    "询问班车，需要老板回复",
  );
  assert.equal(store.public().dailyInsights, undefined);
});
