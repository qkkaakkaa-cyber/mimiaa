const crypto = require("node:crypto");
const { Agent } = require("./agent.cjs");
const { clean, parseSnapshot } = require("./domain.cjs");
const { groupAllowed, isRecentWeChatTime } = require("./discovery.cjs");
class FleetAgent extends Agent {
  constructor(options) {
    super(options);
    this.discovery = null;
    this.seen = new Map();
    this.recentlyChecked = new Map();
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
      if (this.running) this.status = "检测到微信操作或未发送草稿，AI 已自动暂停";
    } else if (this.running) {
      this.status = "微信接待已自动恢复";
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
    const identity = this.settings().identity;
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
      if (automatic && context && snapshot)
        this.store.attributeConversation(context, snapshot, identity.name);
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
      throw new Error("请先为微响开启辅助功能，才能自动识别会话");
    if (!permissions.screen)
      throw new Error("请先为微响开启屏幕录制，用于本地核对消息");
    const d = await this.discover();
    this.seen = new Map(d.sessions.map((row) => [row.id, row]));
    this.recentlyChecked.clear();
    this.queue.clear();
    for (const row of d.sessions) {
      if (this.excluded(row) || row.systemOnly) continue;
      const pending = this.store.data.modelRetries[row.id];
      if (
        pending &&
        Date.now() - pending.failedAt < 30 * 60 * 1000
      )
        this.queue.set(row.id, {
          ...row,
          retryFingerprint: pending.fingerprint,
        });
      else if (row.today && row.unread)
        this.queue.set(row.id, { ...row, unreadBacklog: true });
    }
    this.startedAt = Date.now();
    this.context = null;
    this.draft = null;
    this.running = true;
    this.status = this.queue.size
      ? `已找到 ${this.queue.size} 段今日未读或待重试会话，正在核对`
      : "已自动连接微信，等待私聊和群聊的新消息";
    this.store.log("start", "开启微信多会话接待");
    this.emit();
    this.schedule();
    return this.state();
  }
  async read() {
    if (this.busy) throw new Error("上一项操作还在进行");
    const d = await this.discover();
    if (!d.active) throw new Error("请在微信打开一段聊天，微响会自动识别");
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
      if (this.activityPaused || this.native.control?.isWeChatInUse?.()) {
        this.status = "检测到微信操作或未发送草稿，AI 已自动暂停";
        return;
      }
      let d;
      try {
        d = await this.discover();
      } catch (error) {
        if (!/请展开微信的聊天列表/.test(error.message)) throw error;
        this.status = "微信当前在其他页面，返回聊天列表后继续接待";
        return;
      }
      if (ticket !== this.epoch) return;
      const activeRow = d.sessions.find((row) => row.id === d.active?.sessionId);
      if (activeRow && typeof d.composerText === "string" && !d.composerText.trim() && !this.excluded(activeRow)) {
        const draftTask = this.tasks.find((task) => task.waitingForDraft && task.context.sessionId === activeRow.id);
        if (draftTask) {
          this.tasks = this.tasks.filter((task) => task.id !== draftTask.id);
          this.queue.set(activeRow.id, { ...activeRow, retryFingerprint: draftTask.snapshot.fingerprint });
        }
      }
      const clock = new Date().toLocaleTimeString("en-GB", {
        hour: "2-digit",
        minute: "2-digit",
      });
      for (const row of d.sessions) {
        const previous = this.seen.get(row.id);
        this.seen.set(row.id, row);
        if (this.excluded(row) || row.systemOnly || row.today === false) continue;
        const unreadArrived = row.unread &&
          (!previous?.unread || row.unreadCount > previous.unreadCount);
        if (unreadArrived) {
          this.queue.set(row.id, { ...row, unreadBacklog: true });
        } else if (
          (previous && previous.signature !== row.signature) ||
          (!previous && row.time === clock)
        ) {
          this.queue.set(row.id, row);
        }
      }
      for (const row of d.sessions) {
        if (!this.queue.has(row.id) && !this.excluded(row) &&
            this.recentlyChecked.get(row.id) !== row.signature &&
            isRecentWeChatTime(row.time)) {
          this.queue.set(row.id, { ...row, recentAudit: true });
        }
      }
      const ready = [...this.queue.values()].filter((row) =>
        (!row.retryAfter || row.retryAfter <= Date.now()) &&
        d.sessions.some((session) => session.id === row.id),
      );
      const row = ready.find((candidate) => candidate.id === d.active?.sessionId) || ready[0];
      if (!row) {
        this.status = this.queue.size
          ? "接待中 · 待切换的会话稍后重试"
          : "接待中 · 等待新的私聊和群聊消息";
        if (!this.queue.size && this.idleTime() >= 15) this.scanIdleMoments?.();
        return;
      }
      if (row.recentAudit && !isRecentWeChatTime(row.time)) {
        this.queue.delete(row.id);
        return;
      }
      if (row.unreadBacklog) {
        const current = d.sessions.find((session) => session.id === row.id);
        if (!current || !current.unread || current.systemOnly || current.today === false) {
          this.queue.delete(row.id);
          return;
        }
      }
      if (
        this.idleTime() < 5 &&
        (d.active?.sessionId !== row.id ||
          !this.native.backgroundCapable ||
          this.native.control?.isWeChatInUse?.())
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
        this.queue.set(row.id, { ...row, retryAfter: Date.now() + 12000 });
        this.status = "这段会话暂未切换，其他会话继续接待，稍后重试";
        return;
      }
      if (ticket !== this.epoch) return;
      const context = selected.active;
      if (!context || context.sessionId !== row.id)
        throw new Error("聊天身份无法核对，已停止");
      this.context = context;
      const capture = await this.capture();
      const snapshot = parseSnapshot(capture, this.settings());
      if (ticket !== this.epoch) return;
      if (!snapshot.titleVerified)
        throw new Error("无法核对当前聊天标题，已停止");
      this.latest = snapshot;
      this.recentlyChecked.set(row.id, row.signature);
      if (row.recentAudit && context.kind !== "private") return;
      if (row.systemOnly && !isRecentWeChatTime(capture.messageTime)) {
        this.status = "拍一拍之前没有可核对的近期正文，继续接待";
        return;
      }
      if (
        row.retryFingerprint &&
        row.retryFingerprint !== snapshot.fingerprint
      ) {
        this.store.rememberModelRetry(row.id, null);
        this.status = "先前未回复的消息已变化，等待新消息";
        return;
      }
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
      if (snapshot.last?.role === "in" && this.store.attempted(this.deliveryKey(snapshot))) {
        this.status = "这条消息已有发送记录，继续接待其他会话";
        return;
      }
      const mediaPreview = {
        image: /\[图片\]/u,
        video: /\[视频(?:号)?\]/u,
        sticker: /\[(?:动画)?表情\]/u,
        file: /\[文件\]/u,
      }[snapshot.last?.mediaType];
      if (row.recentAudit && !row.systemOnly && !snapshot.last?.mediaType && snapshot.last?.role === "in") {
        const preview = clean(row.preview);
        const last = clean(snapshot.last.text);
        if (snapshot.last.text.trim() !== row.preview?.trim() &&
            (!preview || (!last.startsWith(preview) && !last.endsWith(preview)))) {
          this.status = "列表预览与最新可见消息不符，继续接待";
          return;
        }
      }
      if (snapshot.last?.role === "in" && mediaPreview && !mediaPreview.test(row.preview || "")) {
        this.status = "媒体消息与会话预览未对上，留给人工核对";
        return;
      }
      if (snapshot.last?.role === "in")
        this.store.insight("in", context, snapshot);
      if (snapshot.last?.role === "in")
        this.learnContact?.(context, snapshot.messages);
      const previousTask = this.tasks.find(
        (t) =>
          t.context.sessionId === context.sessionId &&
          t.snapshot.fingerprint === snapshot.fingerprint,
      );
      if (previousTask || snapshot.last?.role !== "in") {
        this.status = "等待下一条客户消息";
        return;
      }
      let plan;
      try {
        plan = await this.planSnapshot(snapshot, ticket);
      } catch (error) {
        if (!this.running || ticket !== this.epoch) return;
        this.store.rememberModelRetry(row.id, {
          fingerprint: snapshot.fingerprint,
          failedAt: Date.now(),
        });
        const attempts = (row.modelRetryAttempts || 0) + 1;
        if (attempts <= 2) {
          this.queue.set(row.id, {
            ...row,
            retryFingerprint: snapshot.fingerprint,
            modelRetryAttempts: attempts,
          });
          this.status = "AI 暂未生成回复，稍后自动重试";
          this.store.log("warning", error.message);
          return;
        }
        throw error;
      }
      if (ticket !== this.epoch) return;
      if (this.activityPaused) {
        this.queue.set(row.id, row);
        return;
      }
      if (this.store.data.modelRetries[row.id])
        this.store.rememberModelRetry(row.id, null);
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
          waitingForDraft: true,
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
  async summarySessions() {
    if (this.busy) throw new Error("正在处理消息，请稍后再总结");
    this.busy = true;
    try {
      const d = await this.discoverForSummary();
      return {
        activeId: d.active?.sessionId || "",
        sessions: d.sessions.map(({ id, name }) => ({ id, name })),
      };
    } finally {
      this.busy = false;
      this.emit();
      this.schedule();
    }
  }
  async discoverForSummary() {
    try {
      return await this.discover();
    } catch (error) {
      if (
        !this.openChatsForSummary ||
        !/请展开微信的聊天列表/.test(error.message)
      )
        throw error;
      await this.openChatsForSummary();
      return this.discover();
    }
  }
  async summarizeCurrent(sessionId) {
    if (this.busy) throw new Error("正在处理消息，请稍后再总结");
    this.busy = true;
    const ticket = this.epoch;
    try {
      let d = await this.discoverForSummary();
      const identity = sessionId || d.active?.sessionId;
      const row = d.sessions.find((session) => session.id === identity);
      if (!row) throw new Error("这段会话当前不在微信列表中，请重新选择");
      if (d.active?.sessionId !== identity)
        d = await this.native.request("select-session", {
          id: identity,
          signature: row.signature,
          manual: true,
        });
      if (d.active?.sessionId !== identity)
        throw new Error("无法核对需要总结的会话");
      this.context = d.active;
      const snapshot = parseSnapshot(await this.capture(), this.settings());
      if (!snapshot.titleVerified || !snapshot.messages.length)
        throw new Error("当前没有可核对的聊天内容");
      this.phase("正在提取这段聊天的核心…");
      const decision = await this.intelligence().summarize(snapshot.messages);
      if (ticket !== this.epoch) throw new Error("操作已暂停，本次总结取消");
      this.store.conversationReport(this.context, snapshot, decision);
      this.status = "核心总结已保存到记录，未向对方发消息";
    } catch (error) {
      this.status = "总结未完成：" + error.message;
      this.store.log("warning", this.status);
      throw error;
    } finally {
      this.busy = false;
      this.emit();
      this.schedule();
    }
    return this.state();
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
      const key = this.deliveryKey(snapshot);
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
