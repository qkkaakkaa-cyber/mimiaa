const fs = require("node:fs");
const path = require("node:path");
const {
  DEFAULT_SETTINGS,
  validateSettings,
  validateFAQ,
} = require("./domain.cjs");
class Store {
  constructor(dir) {
    this.dir = dir;
    this.file = path.join(dir, "workspace.json");
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    this.data = {
      version: 1,
      settings: structuredClone(DEFAULT_SETTINGS),
      faqs: [],
      documents: [],
      memories: {},
      awayGreetings: {},
      dailyInsights: {},
      conversationReports: [],
      events: [],
      ledger: [],
      encryptedKey: "",
    };
    if (fs.existsSync(this.file)) {
      let saved;
      try {
        saved = JSON.parse(fs.readFileSync(this.file, "utf8"));
      } catch {
        throw new Error("工作空间文件无法读取，已保留原文件，请先备份后修复。");
      }
      this.data = {
        ...this.data,
        ...saved,
        settings: validateSettings({ ...DEFAULT_SETTINGS, ...saved.settings }),
        faqs: (saved.faqs || []).map(validateFAQ),
      };
    }
  }
  flush() {
    const temp = this.file + ".tmp";
    fs.writeFileSync(temp, JSON.stringify(this.data, null, 2), { mode: 0o600 });
    fs.renameSync(temp, this.file);
  }
  public() {
    const {
      encryptedKey,
      ledger,
      memories,
      awayGreetings,
      dailyInsights,
      conversationReports,
      ...data
    } = this.data;
    return structuredClone({ ...data, hasApiKey: !!encryptedKey });
  }
  settings(value) {
    this.data.settings = validateSettings(value);
    this.flush();
    return this.public();
  }
  faq(value) {
    const f = validateFAQ(value);
    const i = this.data.faqs.findIndex((x) => x.id === f.id);
    if (i < 0) {
      if (this.data.faqs.length >= 200) throw new Error("最多保存 200 条问答");
      this.data.faqs.push(f);
    } else this.data.faqs[i] = f;
    this.flush();
    return this.public();
  }
  removeFAQ(id) {
    this.data.faqs = this.data.faqs.filter((x) => x.id !== id);
    this.flush();
    return this.public();
  }
  document(value) {
    const text = String(value.text || "")
        .trim()
        .slice(0, 80000),
      name = String(value.name || "业务资料").slice(0, 180);
    if (!text) throw new Error("资料没有可读取的文字");
    if (this.data.documents.length >= 30)
      throw new Error("最多导入 30 份业务资料");
    this.data.documents.push({
      id: require("node:crypto").randomUUID(),
      name,
      text,
      enabled: true,
      importedAt: new Date().toISOString(),
    });
    this.flush();
    return this.public();
  }
  removeDocument(id) {
    this.data.documents = this.data.documents.filter((d) => d.id !== id);
    this.flush();
    return this.public();
  }
  memoryKey(title) {
    return require("node:crypto")
      .createHash("sha256")
      .update(title)
      .digest("hex");
  }
  memoryFor(title) {
    return this.data.settings.rememberConversations
      ? this.data.memories[this.memoryKey(title)] || {
          messages: [],
          summary: "",
        }
      : { messages: [], summary: "" };
  }
  remember(title, messages, summary = "") {
    if (!this.data.settings.rememberConversations) return;
    this.data.memories[this.memoryKey(title)] = {
      messages: require("./intelligence.cjs").mergeHistory(
        this.memoryFor(title).messages.map((m) => ({
          ...m,
          text: require("./privacy.cjs").redact(m.text),
        })),
        messages.map((m) => ({
          ...m,
          text: require("./privacy.cjs").redact(m.text),
        })),
      ),
      summary: require("./privacy.cjs").redact(
        summary || this.memoryFor(title).summary,
      ),
      updatedAt: new Date().toISOString(),
    };
    const entries = Object.entries(this.data.memories).sort((a, b) =>
      b[1].updatedAt.localeCompare(a[1].updatedAt),
    );
    this.data.memories = Object.fromEntries(entries.slice(0, 100));
    this.flush();
  }
  awayGreetingKey(sessionId, title) {
    return this.memoryKey(sessionId + "|" + title);
  }
  hasAwayGreeting(key) {
    return !!this.data.awayGreetings[key];
  }
  markAwayGreeting(key) {
    this.data.awayGreetings[key] = Date.now();
    this.data.awayGreetings = Object.fromEntries(
      Object.entries(this.data.awayGreetings)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 300),
    );
    this.flush();
  }
  today() {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Shanghai",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(new Date());
  }
  insight(type, context, snapshot, summary = "", finished = false) {
    const day = this.today(),
      data = this.data.dailyInsights[day] || { chats: {}, keys: [] };
    const id = this.memoryKey(context.sessionId || context.expectedTitle),
      key = this.memoryKey(type + "|" + id + "|" + snapshot.fingerprint);
    const entry = data.chats[id] || {
      id,
      title: context.expectedTitle,
      kind: context.kind || "unknown",
      incoming: 0,
      replies: 0,
      summary: "对方发来消息，尚未说明具体事项。",
      firstAt: new Date().toISOString(),
    };
    if (!data.keys.includes(key)) {
      if (type === "in") entry.incoming++;
      if (type === "sent") entry.replies++;
      data.keys.push(key);
    }
    if (summary) entry.summary = String(summary).slice(0, 700);
    if (finished) entry.finished = true;
    entry.updatedAt = new Date().toISOString();
    data.chats[id] = entry;
    data.keys = data.keys.slice(-2000);
    this.data.dailyInsights[day] = data;
    this.data.dailyInsights = Object.fromEntries(
      Object.entries(this.data.dailyInsights)
        .sort((a, b) => b[0].localeCompare(a[0]))
        .slice(0, 14),
    );
    this.flush();
  }
  overview() {
    const day = this.today(),
      items = Object.values(this.data.dailyInsights[day]?.chats || {}).sort(
        (a, b) => b.updatedAt.localeCompare(a.updatedAt),
      );
    return {
      day,
      privateCount: items.filter((i) => i.kind === "private").length,
      groupCount: items.filter((i) => i.kind === "group").length,
      contactsCount: items.length,
      repliesCount: items.reduce((n, i) => n + i.replies, 0),
      updatedAt: items[0]?.updatedAt || "",
      items,
    };
  }
  conversationReport(context, snapshot, decision) {
    const report = decision.conversationReport;
    if (!report?.core) return;
    const { redact } = require("./privacy.cjs");
    const now = new Date().toISOString();
    const current = this.data.conversationReports.find(
      (r) =>
        r.sessionId === context.sessionId &&
        !r.finished &&
        Date.now() - Date.parse(r.updatedAt) < 10 * 60 * 1000,
    );
    const entry = current || {
      id: require("node:crypto").randomUUID(),
      sessionId: context.sessionId,
      title: context.expectedTitle,
      kind: context.kind,
      startedAt: now,
    };
    const list = (items) =>
      (Array.isArray(items) ? items : [])
        .filter((s) => typeof s === "string")
        .slice(0, 5)
        .map((s) => redact(s).slice(0, 300));
    Object.assign(entry, {
      core: redact(report.core).slice(0, 500),
      intent: redact(report.intent || "未明确").slice(0, 500),
      nextSteps: list(report.nextSteps),
      ownerTodo: list(report.ownerTodo),
      finished:
        decision.conversationFinished === true || decision.action === "wrapup",
      updatedAt: now,
      fingerprint: snapshot.fingerprint,
    });
    this.data.conversationReports = [
      entry,
      ...this.data.conversationReports.filter((r) => r.id !== entry.id),
    ]
      .filter((r) => Date.now() - Date.parse(r.updatedAt) < 14 * 86400000)
      .slice(0, 300);
    this.flush();
  }
  reports() {
    return this.data.conversationReports
      .filter((r) => Date.now() - Date.parse(r.updatedAt) < 14 * 86400000)
      .map(({ sessionId, fingerprint, ...r }) => ({
        ...r,
        idle:
          !r.finished && Date.now() - Date.parse(r.updatedAt) >= 10 * 60 * 1000,
      }));
  }
  log(type, message) {
    this.data.events.unshift({
      id: require("node:crypto").randomUUID(),
      type,
      message,
      time: new Date().toISOString(),
    });
    this.data.events = this.data.events.slice(0, 150);
    this.flush();
  }
  attempted(key) {
    return this.data.ledger.some(
      (x) => x.key === key && x.status !== "cancelled",
    );
  }
  record(key, status) {
    const existing = this.data.ledger.find((x) => x.key === key);
    if (existing) {
      existing.status = status;
      existing.time = new Date().toISOString();
    } else
      this.data.ledger.push({ key, status, time: new Date().toISOString() });
    this.data.ledger = this.data.ledger.slice(-500);
    this.flush();
  }
}
module.exports = { Store };
