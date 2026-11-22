const crypto = require("node:crypto");
const { Agent } = require("./agent.cjs");
const { parseSnapshot } = require("./domain.cjs");
const { groupAllowed } = require("./discovery.cjs");
class FleetAgent extends Agent {
  constructor(options) {
    super(options);
    this.discovery = null;
    this.seen = new Map();
    this.queue = new Map();
    this.tasks = [];
    this.processed = 0;
    this.activityPaused = false;
  }
  state() {
    return {
      ...super.state(),
      activityPaused: this.activityPaused,
      overview: this.store.overview(),
      conversationReports: this.store.reports(),
      sessions: (this.discovery?.sessions || []).map(({ id, name }) => ({
        id,
        name,
      })),
      activeTitle: this.context?.expectedTitle || "",
      queueSize: this.queue?.size || 0,
      processed: this.processed || 0,
      tasks: (this.tasks || []).map((t) => ({
        id: t.id,
        title: t.context.expectedTitle,
        kind: t.context.kind,
        reply: t.draft?.text || "",
        reason: t.away ? t.reason : t.analysis?.reason || t.reason,
        summary: t.analysis?.summary || "",
        time: t.time,
      })),
      discovered: !!this.discovery,
    };
  }
  setActivityPaused(active) {
    if (this.activityPaused === active) return;
    this.activityPaused = active;
    if (active) {
      this.native.cancelSends?.();
      if (this.running) this.status = "你正在使用微信，AI 已自动暂停";
    } else if (this.running) {
      this.status = "已离开微信，AI 继续接待";
      if (!this.busy) {
        clearTimeout(this.timer);
        this.timer = setTimeout(() => this.tick(), 250);
      }
    }
    this.emit();
  }
  async planSnapshot(snapshot, ticket) {
    const settings = this.settings();
    if (require("./privacy.cjs").isPrivateRequest(snapshot.last?.text)) {
      this.analysis = require("./privacy.cjs").refusalDecision();
      this.store.conversationReport(this.context, snapshot, this.analysis);
      return {
        kind: settings.mode === "auto" ? "auto" : "draft",
        text: this.analysis.reply,
        source: "隐私保护",
        reason: this.analysis.reason,
        ...(settings.away?.enabled
          ? {
              awayGreetingKey: this.store.awayGreetingKey(
                settings.away.sessionId,
                this.memoryKey(),
              ),
            }
          : {}),
      };
    }
    if (settings.away?.enabled && snapshot.last?.role === "in") {
      const key = this.store.awayGreetingKey(
        settings.away.sessionId,
        this.memoryKey(),
      );
      if (!this.store.hasAwayGreeting(key)) {
        this.phase("AI 正在理解消息并接话…");
        const decision = await this.intelligence().decide(
          snapshot.messages,
          this.store.memoryFor(this.memoryKey()),
          {
            firstIntro: !snapshot.messages.some(
              (m) => m.role === "out" && /(?:AI|代班|助理)/i.test(m.text),
            ),
          },
        );
        if (ticket !== this.epoch)
          throw new Error("接待已暂停，本次 AI 回复取消");
        this.analysis = decision;
        this.store.conversationReport(this.context, snapshot, decision);
        this.store.remember(
          this.memoryKey(),
          snapshot.messages,
          decision.summary,
        );
        if (decision.action === "wait")
          return { kind: "idle", reason: decision.reason };
        return {
          kind:
            settings.mode === "auto" && decision.canAuto
              ? "auto"
              : decision.action === "handoff"
                ? "review"
                : "draft",
          text: decision.reply,
          source: "AI 闲聊",
          reason: decision.reason,
          awayGreetingKey: key,
        };
      }
    }
    return super.planSnapshot(snapshot, ticket);
  }
  async deliver(text, automatic, ticket) {
    const greetingKey = this.draft?.awayGreetingKey,
      context = this.context,
      snapshot = this.latest;
    const result = await super.deliver(text, automatic, ticket);
    if (result.confirmed) {
      if (context && snapshot)
        this.store.insight(
          "sent",
          context,
          snapshot,
          this.analysis?.closingSummary || this.analysis?.summary || "",
          this.analysis?.action === "wrapup",
        );
      if (greetingKey) this.store.markAwayGreeting(greetingKey);
      const hasOwnerTodo = this.analysis?.conversationReport
        ? this.analysis.conversationReport.ownerTodo.length > 0
        : !!this.analysis?.summary;
      if (
        this.settings().away?.enabled &&
        context &&
        snapshot &&
        hasOwnerTodo
      ) {
        const existing = this.tasks.find(
          (t) => t.context.sessionId === context.sessionId && t.away,
        );
        const task = {
          id: existing?.id || crypto.randomUUID(),
          away: true,
          context,
          snapshot,
          draft: null,
          analysis: this.analysis,
          reason: "代班留言 · 醒后回复对方",
          time: new Date().toISOString(),
        };
        this.tasks = [
          task,
          ...this.tasks.filter(
            (t) => t.context.sessionId !== context.sessionId,
          ),
        ].slice(0, 30);
      } else if (context) {
        this.tasks = this.tasks.filter(
          (t) => !(t.away && t.context.sessionId === context.sessionId),
        );
      }
    }
    return result;
  }
  async discover() {
    this.discovery = await this.native.request("discover");
    this.emit();
    return this.discovery;
  }
  stop(reason) {
    super.stop(reason);
    this.queue?.clear();
  }
  excluded(row) {
    return this.store.data.settings.reception.excluded.includes(row.name);
  }
  async start() {
    if (this.busy) throw new Error("上一项操作还在进行");
    this.stop("正在自动查找微信…");
    const permissions = await this.native.request("permissions");
    if (!permissions.accessibility)
      throw new Error("请先为回响开启辅助功能，才能自动识别会话");
    if (!permissions.screen)
      throw new Error("请先为回响开启屏幕录制，用于本地核对消息");
    const d = await this.discover();
    this.seen = new Map(d.sessions.map((s) => [s.id, s.signature]));
    this.queue.clear();
    this.startedAt = Date.now();
    this.context = null;
    this.draft = null;
    this.running = true;
    this.status = "已自动连接微信，等待私聊和群聊的新消息";
    this.store.log("start", "开启微信多会话接待");
    this.emit();
    this.schedule();
    return this.state();
  }
  async read() {
    if (this.busy) throw new Error("上一项操作还在进行");
    const d = await this.discover();
    if (!d.active) throw new Error("请在微信打开一段聊天，回响会自动识别");
    this.context = d.active;
    return super.read();
  }
  async generate() {
    if (!this.context) {
      const d = await this.discover();
      if (!d.active) throw new Error("请展开微信聊天");
      this.context = d.active;
    }
    return super.generate();
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
      if (this.activityPaused || this.native.control?.isWeChatActive?.()) {
        this.status = "你正在使用微信，AI 已自动暂停";
        return;
      }
      const d = await this.discover();
      if (ticket !== this.epoch) return;
      for (const row of d.sessions) {
        const previous = this.seen.get(row.id);
        this.seen.set(row.id, row.signature);
        // Ignore old newly exposed rows after manual scrolling. New conversations
        // must carry unread evidence or a current-minute timestamp.
        const clock = new Date().toLocaleTimeString("en-GB", {
          hour: "2-digit",
          minute: "2-digit",
        });
        if (
          !this.excluded(row) &&
          ((previous !== undefined && previous !== row.signature) ||
            (previous === undefined && (row.unread || row.time === clock)))
        )
          this.queue.set(row.id, row);
      }
      const row = this.queue.values().next().value;
      if (!row) {
        this.status = "接待中 · 等待新的私聊和群聊消息";
        return;
      }
      if (
        this.idleTime() < 5 &&
        (d.active?.sessionId !== row.id ||
          !this.native.backgroundCapable ||
          this.native.control?.isWeChatActive?.())
      ) {
        this.status =
          d.active?.sessionId === row.id
            ? "你正在操作微信，稍后继续回复"
            : "已发现新消息，等待空闲切换会话";
        return;
      }
      this.queue.delete(row.id);
      this.phase("正在读取新消息会话…");
      let selected;
      try {
        selected = await this.native.request("select-session", {
          id: row.id,
          signature: row.signature,
        });
      } catch (error) {
        if (ticket !== this.epoch) return;
        this.queue.set(row.id, row);
        this.status = error.message;
        return;
      }
      if (ticket !== this.epoch) return;
      const context = selected.active;
      if (!context || context.sessionId !== row.id)
        throw new Error("聊天身份无法核对，已停止");
      this.context = context;
      const snapshot = parseSnapshot(await this.capture(), this.settings());
      if (ticket !== this.epoch) return;
      if (!snapshot.titleVerified)
        throw new Error("无法核对当前聊天标题，已停止");
      this.latest = snapshot;
      if (snapshot.last?.mediaType === "voice" && !snapshot.last.transcribed) {
        this.status = "收到语音，需先完成微信转文字";
        this.tasks.unshift({
          id: crypto.randomUUID(),
          context,
          snapshot,
          draft: null,
          reason: "这条语音尚未转成文字，未让 AI 猜测内容",
          analysis: null,
          time: new Date().toISOString(),
        });
        this.tasks = this.tasks.slice(0, 30);
        return;
      }
      if (this.activityPaused) {
        this.queue.set(row.id, row);
        return;
      }
      if (!groupAllowed(context, snapshot, this.store.data.settings)) {
        this.status =
          context.kind === "unknown"
            ? "无法确认私聊或群聊类型，留给人工"
            : "当前会话不满足接待范围，已略过";
        return;
      }
      if (snapshot.last?.role === "in")
        this.store.insight("in", context, snapshot);
      const previousTask = this.tasks.find(
        (t) =>
          t.context.sessionId === context.sessionId &&
          t.snapshot.fingerprint === snapshot.fingerprint,
      );
      if (previousTask || snapshot.last?.role !== "in") {
        this.status = "等待下一条客户消息";
        return;
      }
      const plan = await this.planSnapshot(snapshot, ticket);
      if (ticket !== this.epoch) return;
      if (this.activityPaused) {
        this.queue.set(row.id, row);
        return;
      }
      if (plan.kind === "idle") {
        this.status = plan.reason;
        return;
      }
      this.draft = plan.text
        ? {
            id: crypto.randomUUID(),
            text: plan.text,
            source: plan.source,
            fingerprint: snapshot.fingerprint,
            windowId: context.windowId,
            title: context.expectedTitle,
            awayGreetingKey: plan.awayGreetingKey,
          }
        : null;
      if (plan.kind === "auto" && this.draft) {
        await this.deliver(plan.text, true, ticket);
        this.processed++;
      } else {
        this.tasks = this.tasks.filter(
          (t) => t.context.sessionId !== context.sessionId,
        );
        this.tasks.unshift({
          id: crypto.randomUUID(),
          context,
          analysis: this.analysis,
          reason: plan.reason,
          draft: this.draft,
          snapshot,
          time: new Date().toISOString(),
        });
        this.tasks = this.tasks.slice(0, 30);
        this.draft = null;
        this.status = "有会话需要你处理，其他会话继续接待";
        this.store.log("handoff", "有会话需要人工确认");
      }
    } catch (error) {
      if (error.needsHuman && this.running && this.context && this.latest) {
        this.tasks.unshift({
          id: crypto.randomUUID(),
          context: this.context,
          snapshot: this.latest,
          draft: null,
          reason: "微信留有你的草稿，请处理后再接待这段会话",
          analysis: null,
          time: new Date().toISOString(),
        });
        this.tasks = this.tasks.slice(0, 30);
        this.status = "这段会话留给你处理，其他会话继续接待";
      } else if (error.canRetry && this.running && ticket === this.epoch) {
        const d = await this.discover().catch(() => null),
          row = d?.sessions.find((r) => r.id === this.context?.sessionId);
        if (row) this.queue.set(row.id, row);
        this.status = "消息已更新，正在重新核对后回复";
      } else {
        this.stop(error.message);
        this.store.log("warning", error.message);
      }
    } finally {
      this.busy = false;
      this.emit();
      this.schedule();
    }
  }
  async summarizeCurrent() {
    if (this.busy) throw new Error("正在处理消息，请稍后再总结");
    this.busy = true;
    const ticket = this.epoch;
    try {
      const d = await this.discover();
      if (!d.active?.sessionId) throw new Error("请在微信打开需要总结的聊天");
      this.context = d.active;
      const snapshot = parseSnapshot(await this.capture(), this.settings());
      if (!snapshot.titleVerified || !snapshot.messages.length)
        throw new Error("当前没有可核对的聊天内容");
      this.phase("正在提取这段聊天的核心…");
      const decision = await this.intelligence().summarize(snapshot.messages);
      if (ticket !== this.epoch) throw new Error("操作已暂停，本次总结取消");
      this.store.conversationReport(this.context, snapshot, decision);
      this.status = "核心总结已保存到记录，未向对方发消息";
      return this.state();
    } finally {
      this.busy = false;
      this.emit();
      this.schedule();
    }
  }
  async retryCurrent(options = {}) {
    if (options.confirmedPrepared && !this.running) await this.start();
    if (!this.running) throw new Error("先开启接待");
    const d = await this.discover(),
      row = d.sessions.find((r) => r.id === d.active?.sessionId);
    if (!row) throw new Error("请在微信打开需要处理的聊天");
    if (this.excluded(row)) throw new Error("这段聊天在不接待名单中");
    if (options.confirmedPrepared) {
      if (options.expectedTitle !== d.active.expectedTitle)
        throw new Error("聊天对象已变化，未执行重试");
      const greeting = this.settings().away?.greeting;
      if (!this.settings().away?.enabled || d.composerText !== greeting)
        throw new Error("只允许继续发送你已核对的代班开场白");
      this.context = d.active;
      const snapshot = parseSnapshot(await this.capture(), this.settings());
      if (!snapshot.titleVerified || snapshot.last?.role !== "in")
        throw new Error("无法确认需要回复的客户消息");
      if (
        snapshot.messages.some((m) => m.role === "out" && m.text === greeting)
      )
        throw new Error("已在会话中找到这条回复，不重复发送");
      const key = crypto
        .createHash("sha256")
        .update(this.memoryKey() + "|" + snapshot.fingerprint)
        .digest("hex");
      const record = this.store.data.ledger.find((r) => r.key === key);
      if (record?.status === "unconfirmed") this.store.record(key, "cancelled");
    }
    this.queue.set(row.id, row);
    this.emit();
    if (!this.busy) await this.tick();
    return this.state();
  }
  async reviewTask(id) {
    if (this.busy) throw new Error("请等待本次接待完成");
    const task = this.tasks.find((t) => t.id === id);
    if (!task) throw new Error("这条待办已经处理");
    this.stop("你正在处理一段会话，自动接待已暂停");
    const d = await this.discover(),
      row = d.sessions.find((s) => s.id === task.context.sessionId);
    if (!row) throw new Error("该会话暂不在微信列表中，请在微信打开后重试");
    const selected = await this.native.request("select-session", {
      id: row.id,
      signature: row.signature,
    });
    this.context = selected.active;
    this.draft = task.draft;
    this.latest = task.snapshot;
    this.analysis = task.analysis;
    this.reviewing = id;
    this.emit();
    return this.state();
  }
  async send(text) {
    const result = await super.send(text);
    if (result.confirmed && this.reviewing) {
      this.tasks = this.tasks.filter((t) => t.id !== this.reviewing);
      this.reviewing = null;
      this.emit();
    }
    return result;
  }
}
module.exports = { FleetAgent };
