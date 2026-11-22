const crypto = require("node:crypto");
const { Intelligence } = require("./intelligence.cjs");
const {
  parseSnapshot,
  planReply,
  validateEndpoint,
  within,
} = require("./domain.cjs");
class Agent {
  constructor({ store, native, notify, idleTime, getKey }) {
    Object.assign(this, { store, native, notify, idleTime, getKey });
    this.running = false;
    this.busy = false;
    this.epoch = 0;
    this.draft = null;
    this.latest = null;
    this.lastSeen = "";
    this.timer = null;
    this.status = "尚未连接微信";
    this.analysis = null;
    this.activities = [];
  }
  settings() {
    return this.context
      ? { ...this.store.data.settings, ...this.context }
      : this.store.data.settings;
  }
  memoryKey() {
    return this.context?.sessionId || this.settings().expectedTitle;
  }
  state() {
    return {
      running: this.running,
      busy: this.busy,
      status: this.status,
      draft: this.draft,
      latest: this.latest,
      analysis: this.analysis,
      activities: this.activities,
    };
  }
  emit() {
    this.notify(this.state());
  }
  phase(label) {
    this.status = label;
    this.activities = [
      ...this.activities,
      { label, time: new Date().toISOString() },
    ].slice(-6);
    this.emit();
  }
  intelligence() {
    return new Intelligence({ data: this.store.data, getKey: this.getKey });
  }
  async planSnapshot(snapshot, ticket) {
    if (snapshot.last?.role !== "in")
      return { kind: "idle", reason: "等待客户的新消息" };
    const s = this.settings();
    if (!s.model.baseUrl || !s.model.name)
      return planReply(snapshot, s, this.store.data.faqs);
    this.phase(
      s.away?.enabled
        ? "AI 正在结合上下文接话…"
        : "正在结合业务资料和会话记忆理解客户需求…",
    );
    const decision = await this.intelligence().decide(
      snapshot.messages,
      this.store.memoryFor(this.memoryKey()),
    );
    if (ticket !== this.epoch)
      throw new Error("接待已暂停，本次 AI 方案不会继续执行");
    this.analysis = decision;
    if (this.context)
      this.store.conversationReport(this.context, snapshot, decision);
    this.store.remember(this.memoryKey(), snapshot.messages, decision.summary);
    const source = decision.sourceNames.join(" · ") || "AI 需求澄清";
    if (decision.action === "wait")
      return { kind: "idle", reason: decision.reason };
    return {
      kind:
        s.mode === "auto" && decision.canAuto
          ? "auto"
          : decision.action === "handoff"
            ? "review"
            : "draft",
      text: decision.reply,
      source,
      reason: decision.reason,
    };
  }
  stop(reason = "接待已暂停") {
    this.running = false;
    this.epoch++;
    clearTimeout(this.timer);
    this.native.cancelSends?.();
    this.status = reason;
    this.emit();
  }
  async capture() {
    const s = this.settings();
    if (!s.windowId) throw new Error("先连接微信窗口");
    const result = await this.native.request("capture", {
      windowId: s.windowId,
    });
    const snapshot = parseSnapshot(result, s);
    require("node:fs").writeFileSync(
      require("node:path").join(this.store.dir, "read-diagnostics.json"),
      JSON.stringify({
        time: new Date().toISOString(),
        regions: s.calibration,
        titleVerified: snapshot.titleVerified,
        count: snapshot.messages.length,
        lastRole: snapshot.last?.role,
        tail: result.lines
          .filter((l) => within(l.box, s.calibration.messages))
          .slice(-12)
          .map((l) => ({
            confidence: l.confidence,
            box: l.box,
            outgoing: l.outgoing,
            textLength: l.text.length,
            isGreeting: /^(?:在吗|hi|你好)$/i.test(l.text),
          })),
      }),
      { mode: 0o600 },
    );
    return result;
  }
  async read() {
    if (this.busy) throw new Error("上一项操作还在进行，请稍候");
    this.busy = true;
    this.emit();
    try {
      const c = await this.capture();
      const parsed = parseSnapshot(c, this.settings());
      this.latest = parsed;
      this.draft = null;
      if (!parsed.titleVerified)
        throw new Error("未找到指定会话名称，请检查当前聊天对象和标记区域");
      this.store.remember(this.memoryKey(), parsed.messages);
      this.status =
        parsed.last?.role === "in"
          ? "已读取客户消息，可以生成草稿"
          : "已读取窗口，等待客户消息";
      return { capture: c, snapshot: parsed };
    } finally {
      this.busy = false;
      this.emit();
    }
  }
  async generate() {
    if (this.busy) throw new Error("上一项操作还在进行，请稍候");
    this.busy = true;
    this.emit();
    const ticket = this.epoch;
    try {
      const parsed = parseSnapshot(await this.capture(), this.settings());
      this.latest = parsed;
      if (!parsed.titleVerified)
        throw new Error("聊天对象已变化，请重新确认会话");
      if (parsed.last?.role !== "in")
        throw new Error("没有可明确识别的最新客户消息，请检查消息区域");
      const plan = await this.planSnapshot(parsed, ticket);
      let text = plan.text,
        source = plan.source;
      if (!text)
        throw new Error(plan.reason || "请先添加业务资料，再生成回复。");
      if (ticket !== this.epoch)
        throw new Error("操作已暂停，本次草稿未继续处理");
      this.draft = {
        id: crypto.randomUUID(),
        text,
        source,
        fingerprint: parsed.fingerprint,
        windowId: this.settings().windowId,
        title: this.settings().expectedTitle,
        awayGreetingKey: plan.awayGreetingKey,
      };
      this.status = "回复草稿已准备好";
      return this.draft;
    } finally {
      this.busy = false;
      this.emit();
    }
  }
  async modelReply(messages, test = false) {
    if (test)
      return this.intelligence().complete(
        [{ role: "user", content: "请只回复：连接成功" }],
        { test: true },
      );
    return (
      await this.intelligence().decide(
        messages,
        this.store.memoryFor(this.memoryKey()),
      )
    ).reply;
  }
  async start() {
    if (this.busy) throw new Error("请等待当前操作结束");
    this.stop("正在检查接待条件");
    const s = this.settings();
    if (!s.windowId || !s.expectedTitle)
      throw new Error("先连接微信，并填写接待的会话名称");
    const permissions = await this.native.request("permissions");
    if (!permissions.screen) throw new Error("请先开启屏幕录制权限");
    if (s.mode === "auto" && !permissions.accessibility)
      throw new Error("自动发送需要辅助功能权限");
    const parsed = parseSnapshot(await this.capture(), s);
    if (!parsed.titleVerified)
      throw new Error("当前微信会话名称不匹配，无法开始接待");
    this.latest = parsed;
    this.lastSeen = parsed.fingerprint;
    this.running = true;
    this.status = "接待已开始，等待新的客户消息";
    this.store.log("start", "开始接待指定微信会话");
    this.emit();
    this.schedule();
    return this.state();
  }
  schedule() {
    clearTimeout(this.timer);
    if (this.running)
      this.timer = setTimeout(
        () => this.tick(),
        this.settings().interval * 1000,
      );
  }
  async tick() {
    if (!this.running) return;
    if (this.busy) {
      this.schedule();
      return;
    }
    this.busy = true;
    const ticket = this.epoch;
    try {
      if (this.idleTime() < 5) {
        this.status = "检测到人工操作，等待你离开电脑后继续";
        return;
      }
      const parsed = parseSnapshot(await this.capture(), this.settings());
      if (!this.running || ticket !== this.epoch) return;
      this.latest = parsed;
      if (!parsed.titleVerified) {
        this.stop("聊天对象变化，已自动停止接待");
        this.store.log("warning", "会话校验失败，已停止接待");
        return;
      }
      if (parsed.fingerprint === this.lastSeen) {
        this.status = "接待中 · 暂无新消息";
        return;
      }
      this.lastSeen = parsed.fingerprint;
      this.draft = null;
      const plan = await this.planSnapshot(parsed, ticket);
      if (plan.kind === "idle") {
        this.status = plan.reason;
        return;
      }
      if (!plan.text) {
        this.status = plan.reason;
        this.store.log("handoff", "新消息需要人工处理");
        return;
      }
      this.draft = {
        id: crypto.randomUUID(),
        text: plan.text,
        source: plan.source,
        fingerprint: parsed.fingerprint,
        windowId: this.settings().windowId,
        title: this.settings().expectedTitle,
        awayGreetingKey: plan.awayGreetingKey,
      };
      if (plan.kind === "auto") {
        await this.deliver(plan.text, true, ticket);
      } else {
        this.status = "有新的回复草稿，等待你确认";
        this.store.log("draft", "已结合业务资料准备回复，等待确认");
      }
    } catch (e) {
      this.stop(e.message);
      this.store.log("warning", e.message);
    } finally {
      this.busy = false;
      this.emit();
      this.schedule();
    }
  }
  async send(text) {
    if (this.busy) throw new Error("上一项操作还在进行，请稍候");
    this.busy = true;
    this.emit();
    try {
      return await this.deliver(text, false, this.epoch);
    } finally {
      this.busy = false;
      this.emit();
    }
  }
  async deliver(value, automatic, ticket) {
    const text = String(value || "")
      .trim()
      .replace(/[\r\n]+/g, " ");
    if (!text || text.length > 1500)
      throw new Error("回复内容需要在 1～1500 字之间");
    if (!this.draft) throw new Error("请先读取会话并生成一份草稿");
    const s = this.settings();
    if (
      this.draft.windowId !== s.windowId ||
      this.draft.title !== s.expectedTitle
    )
      throw new Error("接待对象已变更，请重新生成草稿");
    if (
      automatic &&
      (!this.running ||
        ticket !== this.epoch ||
        (!this.native.backgroundCapable && this.idleTime() < 5))
    )
      throw new Error("自动发送已取消，请检查接待状态");
    const checkCapture = await this.capture();
    const parsed = parseSnapshot(checkCapture, s);
    if (!parsed.titleVerified || parsed.fingerprint !== this.draft.fingerprint)
      throw new Error("聊天内容已变化，请重新读取后再回复");
    const expectedOCR = checkCapture.lines
      .filter((l) => within(l.box, s.calibration.messages))
      .sort((a, b) => a.box.y - b.box.y || a.box.x - b.box.x)
      .map((l) => l.text);
    const ledgerKey = crypto
      .createHash("sha256")
      .update(this.memoryKey() + "|" + parsed.fingerprint)
      .digest("hex");
    if (this.store.attempted(ledgerKey))
      throw new Error("这条消息已有发送记录，为避免重复，请到微信中确认");
    if (ticket !== this.epoch) throw new Error("操作已暂停，本次发送已取消");
    this.store.record(ledgerKey, "attempted");
    try {
      await this.native.request("send", {
        windowId: s.windowId,
        expectedTitle: s.expectedTitle,
        calibration: s.calibration,
        text,
        width: parsed.width,
        height: parsed.height,
        automatic,
        expectedOCR,
        expectedFingerprint: parsed.fingerprint,
      });
      let after,
        confirmed = false;
      // WeChat may accept Return before rendering its outgoing bubble. Read
      // again without ever issuing a second send, including after new input.
      for (let attempt = 0; attempt < 5; attempt++) {
        if (attempt) await new Promise((resolve) => setTimeout(resolve, 450));
        after = parseSnapshot(await this.capture(), s);
        if (!after.titleVerified) break;
        confirmed = after.messages.some(
          (m) =>
            m.role === "out" &&
            m.text
              .normalize("NFKC")
              .replace(/\s/g, "")
              .includes(text.normalize("NFKC").replace(/\s/g, "")),
        );
        if (confirmed || ticket !== this.epoch) break;
      }
      this.store.record(ledgerKey, confirmed ? "confirmed" : "unconfirmed");
      this.latest = after;
      if (after.titleVerified)
        this.store.remember(
          this.memoryKey(),
          after.messages,
          this.analysis?.summary || "",
        );
      this.lastSeen =
        after.last?.role === "in" ? parsed.fingerprint : after.fingerprint;
      this.draft = null;
      this.status = confirmed
        ? "回复已在微信窗口中确认"
        : "发送结果待核实，请到微信检查，不会自动重发";
      this.store.log(
        confirmed ? "sent" : "warning",
        confirmed ? "回复已发送并读回确认" : "已执行发送，但未能读回确认",
      );
      if (!confirmed) this.stop(this.status);
      return { confirmed };
    } catch (e) {
      if (e.sendAttempted === false) {
        this.store.record(ledgerKey, "cancelled");
        this.draft = null;
        this.status = e.message;
        if (/已有内容|已有草稿/.test(e.message)) e.needsHuman = true;
        if (!e.canRetry && !e.needsHuman) this.stop(e.message);
        throw e;
      }
      this.store.record(ledgerKey, "unconfirmed");
      this.stop("发送未确认，请到微信检查；不会自动重发");
      this.store.log("warning", "发送未确认，已停止接待");
      throw e;
    }
  }
}
module.exports = { Agent };
