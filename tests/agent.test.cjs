const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { Store } = require("../app/lib/store.cjs");
const { Agent } = require("../app/lib/agent.cjs");
const { DEFAULT_SETTINGS, parseSnapshot } = require("../app/lib/domain.cjs");
function line(text, y, out = false) {
  return {
    text,
    box: { x: out ? 0.62 : 0.35, y, w: 0.15, h: 0.03 },
    outgoing: out,
  };
}
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "huixiang-test-"));
  const store = new Store(dir);
  store.settings({ ...DEFAULT_SETTINGS, windowId: 1, expectedTitle: "客户甲" });
  store.faq({
    question: "你好",
    answer: "您好，欢迎咨询",
    enabled: true,
    autoSend: true,
  });
  const fake = {
    current: {
      width: 1000,
      height: 800,
      lines: [line("客户甲", 0.04), line("你好", 0.25)],
    },
    sends: 0,
    fail: false,
    extraAfter: null,
    async request(cmd, payload) {
      if (cmd === "permissions") return { screen: true, accessibility: true };
      if (cmd === "capture") return structuredClone(this.current);
      if (cmd === "send") {
        this.sends++;
        assert.ok(payload.expectedOCR.length);
        if (this.fail) throw new Error("模拟发送中断");
        this.current.lines.push(line(payload.text, 0.5, true));
        if (this.extraAfter)
          this.current.lines.push(line(this.extraAfter, 0.65));
        return { attempted: true };
      }
      throw new Error("unexpected command");
    },
  };
  const agent = new Agent({
    store,
    native: fake,
    notify: () => {},
    idleTime: () => 10,
    getKey: async () => "",
  });
  t.after(() => {
    agent.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return { store, fake, agent, dir };
}
test("初次启动只建立基线，不补发旧消息", async (t) => {
  const { agent, fake } = fixture(t);
  await agent.start();
  assert.equal(fake.sends, 0);
  await agent.tick();
  assert.equal(fake.sends, 0);
  assert.equal(agent.running, true);
});
test("人工确认发送后需要在窗口读回才能标记成功", async (t) => {
  const { agent, fake, store } = fixture(t);
  await agent.generate();
  const result = await agent.send("您好，欢迎咨询");
  assert.equal(result.confirmed, true);
  assert.equal(fake.sends, 1);
  assert.equal(store.data.ledger[0].status, "confirmed");
  assert.equal(agent.draft, null);
});
test("草稿之后客户有新消息时拒绝发送", async (t) => {
  const { agent, fake, store } = fixture(t);
  await agent.generate();
  fake.current.lines.push(line("等一下", 0.4));
  await assert.rejects(() => agent.send("您好"), /聊天内容已变化/);
  assert.equal(fake.sends, 0);
  assert.equal(store.data.ledger.length, 0);
});
test("微信延迟显示已发气泡时只重复读回，不重复发送", async (t) => {
  const { agent, fake, store } = fixture(t);
  const request = fake.request.bind(fake);
  let delayed,
    reads = 0;
  fake.request = async (cmd, payload) => {
    if (cmd === "send") {
      fake.sends++;
      delayed = line(payload.text, 0.5, true);
      return { attempted: true };
    }
    if (cmd === "capture" && delayed && ++reads === 2)
      fake.current.lines.push(delayed);
    return request(cmd, payload);
  };
  await agent.generate();
  assert.equal((await agent.send("您好，欢迎咨询")).confirmed, true);
  assert.equal(fake.sends, 1);
  assert.equal(store.data.ledger[0].status, "confirmed");
});
test("辅助功能统一全角标点后仍能确认实际已发中文回复", async (t) => {
  const { agent, fake } = fixture(t);
  const request = fake.request.bind(fake);
  fake.request = async (cmd, payload) =>
    request(
      cmd,
      cmd === "send"
        ? { ...payload, text: payload.text.normalize("NFKC") }
        : payload,
    );
  await agent.generate();
  assert.equal(
    (await agent.send("你好，我在呢！想聊些什么？")).confirmed,
    true,
  );
  assert.equal(fake.sends, 1);
});
test("聊天对象变化时不发送，并停止自动接待", async (t) => {
  const { agent, fake } = fixture(t);
  await agent.start();
  fake.current.lines[0].text = "其他客户";
  await agent.tick();
  assert.equal(agent.running, false);
  assert.equal(fake.sends, 0);
});
test("发送过程失败后记录不明确结果，阻止重复发送", async (t) => {
  const { agent, fake, store } = fixture(t);
  await agent.generate();
  fake.fail = true;
  await assert.rejects(() => agent.send("您好"), /模拟发送中断/);
  assert.equal(store.data.ledger[0].status, "unconfirmed");
  await assert.rejects(() => agent.send("您好"), /已有发送记录/);
  assert.equal(fake.sends, 1);
});
test("发送过程中出现新客户消息，不把它当作已处理", async (t) => {
  const { agent, fake } = fixture(t);
  await agent.generate();
  const before = agent.draft.fingerprint;
  fake.extraAfter = "谢谢，还有别的问题";
  await agent.send("您好");
  assert.equal(agent.lastSeen, before);
  assert.notEqual(agent.lastSeen, agent.latest.fingerprint);
});
test("生成草稿过程中暂停使在途操作失效", async (t) => {
  const { agent, fake } = fixture(t);
  let resolve;
  const ready = new Promise((r) => (resolve = r));
  const original = fake.request.bind(fake);
  fake.request = async (cmd, p) =>
    cmd === "capture" ? (await ready, original(cmd, p)) : original(cmd, p);
  const running = agent.generate();
  agent.stop();
  resolve();
  await assert.rejects(() => running, /已暂停/);
  assert.equal(agent.draft, null);
});
test("紧急暂停取消在途发送，并保留待核实记录", async (t) => {
  const { agent, fake, store } = fixture(t);
  await agent.generate();
  let rejectSend, entered;
  const started = new Promise((r) => (entered = r));
  const original = fake.request.bind(fake);
  fake.request = (cmd, p) =>
    cmd === "send"
      ? new Promise((_resolve, reject) => {
          rejectSend = reject;
          entered();
        })
      : original(cmd, p);
  fake.cancelSends = () => {
    if (rejectSend) {
      const reject = rejectSend;
      rejectSend = null;
      reject(new Error("发送已取消"));
    }
  };
  const sending = agent.send("您好");
  await started;
  agent.stop("紧急暂停");
  await assert.rejects(() => sending, /发送已取消/);
  assert.equal(store.data.ledger[0].status, "unconfirmed");
  assert.equal(agent.running, false);
});
test("自动模式仅发送新出现且已授权的问答", async (t) => {
  const { agent, fake, store } = fixture(t);
  store.settings({ ...store.data.settings, mode: "auto" });
  await agent.start();
  fake.current.lines = [
    line("客户甲", 0.04),
    line("前一条", 0.2),
    line("你好", 0.4),
  ];
  await agent.tick();
  assert.equal(fake.sends, 1);
  await agent.tick();
  assert.equal(fake.sends, 1);
});
test("密钥不出现在前端工作空间返回值中", (t) => {
  const { store } = fixture(t);
  store.data.encryptedKey = "secret-encrypted";
  const publicState = store.public();
  assert.equal(publicState.hasApiKey, true);
  assert.equal(JSON.stringify(publicState).includes("secret-encrypted"), false);
  assert.equal(publicState.ledger, undefined);
});
test("工作空间持久化保留设置与问答", (t) => {
  const { store, dir } = fixture(t);
  store.log("draft", "生成草稿");
  const reopened = new Store(dir);
  assert.equal(reopened.data.settings.expectedTitle, "客户甲");
  assert.equal(reopened.data.faqs.length, 1);
  assert.equal(reopened.data.events[0].message, "生成草稿");
  assert.equal(
    fs.statSync(path.join(dir, "workspace.json")).mode & 0o777,
    0o600,
  );
});
test("原生组件确认尚未输入或发送时，可取消本次账本并保留接待", async (t) => {
  const { agent, fake, store } = fixture(t);
  await agent.generate();
  agent.running = true;
  const original = fake.request.bind(fake);
  fake.request = async (cmd, p) => {
    if (cmd === "send") {
      const e = new Error("客户消息发生变化，已取消发送");
      e.sendAttempted = false;
      e.canRetry = true;
      throw e;
    }
    return original(cmd, p);
  };
  await assert.rejects(() => agent.send("您好"), /客户消息发生变化/);
  assert.equal(store.data.ledger[0].status, "cancelled");
  assert.equal(store.attempted(store.data.ledger[0].key), false);
  assert.equal(agent.running, true);
});
