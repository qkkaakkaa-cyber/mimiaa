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
    const { encryptedKey, ledger, ...data } = this.data;
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
    return this.data.ledger.some((x) => x.key === key);
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
