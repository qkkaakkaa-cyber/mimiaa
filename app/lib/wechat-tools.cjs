const { createHash, randomUUID } = require("node:crypto");
const { redact, isPrivateRequest } = require("./privacy.cjs");
const { discoverFromAX } = require("./discovery.cjs");
const { parseSnapshot } = require("./domain.cjs");

const itemText = (item) =>
  String(item?.value || item?.label || item?.title || "").trim();
const has = (view, id) => view.items.some((item) => item.id === id);
const button = (view, name) =>
  view.items.find(
    (item) =>
      item.role === "AXButton" &&
      [item.label, item.title, item.value].some(
        (value) => String(value).trim() === name,
      ),
  );
const digest = (value) => createHash("sha256").update(value).digest("hex");
const categories = [
  ["招聘用工", /招聘|诚聘|招工|招聘中介|hiring|รับสมัคร/i],
  ["求职咨询", /求职|找工作|looking for work|หางาน/i],
  ["教育培训", /培训|学校|教育|课程|老师|teacher|school/i],
  ["商贸物流", /物流|快递|贸易|供应|批发|外贸|运输|logistics/i],
  ["企业服务", /咨询|企业服务|财税|会计|翻译|工商|consulting/i],
  ["零售餐饮", /餐饮|外卖|咖啡店|超市|零售|电商|restaurant|retail/i],
  ["传媒内容", /媒体|记者|编辑|短视频|直播运营|摄影|newsroom/i],
  ["科技开发", /软件开发|程序员|开发工程师|技术支持|developer/i],
  ["旅游服务", /旅游|导游|旅行社|酒店|travel agency/i],
  ["工程房产", /房地产|装修|房产中介|建筑工程|construction/i],
];
const classify = (text) =>
  categories
    .filter(([, pattern]) => pattern.test(text))
    .map(([category]) => category);

function profileFromAX(view) {
  const name = itemText(
    view.items.find((item) => item.id === "display_name_text"),
  );
  const avatar = view.items.find((item) => item.id === "head_view_");
  if (!name || !avatar) throw new Error("请先在微信通讯录中点开一位联系人");
  const signatureLabel = view.items.findIndex((item) =>
    /(?:个性签名|Signature)$/i.test(itemText(item)),
  );
  const signature =
    signatureLabel < 0
      ? ""
      : itemText(
          view.items
            .slice(signatureLabel + 1, signatureLabel + 4)
            .find((item) => item.id === "value_reader_"),
        );
  const identity = view.items
    .map(itemText)
    .join("\n")
    .match(/(?:WeChat ID|微信号)\s*[:：]\s*([a-z0-9_-]+)/i)?.[1];
  const evidence = [name, signature].join("\n");
  const matches = classify(evidence);
  return {
    id: identity ? digest(identity.toLowerCase()) : randomUUID(),
    name: redact(name).slice(0, 120),
    signature: redact(signature.normalize("NFKC")).slice(0, 600),
    categories: matches.length ? matches : ["待确认"],
    avatarFrame: avatar.frame,
  };
}

function historyEvidence(messages) {
  const captures = [];
  for (const message of messages) {
    if (message.role !== "in" || isPrivateRequest(message.text)) continue;
    for (const phrase of redact(message.text.normalize("NFKC")).split(
      /[。！？!?；;\n]/,
    )) {
      const statement = phrase.trim();
      if (
        !/^(?:我(?:现在|目前|平时|主要)?(?:是做|是|在做|做|从事|负责|经营|开了)|我们公司(?:主要|目前)?(?:做|经营|主营|在招聘))/.test(
          statement,
        )
      )
        continue;
      if (/假设|比如|如果|不做|不是|朋友|家人|同行|以前|曾经/.test(statement))
        continue;
      const matching = classify(statement);
      if (matching.length)
        captures.push({ text: statement.slice(0, 95), categories: matching });
    }
  }
  const unique = new Map(captures.map((entry) => [entry.text, entry]));
  return [...unique.values()].slice(-6);
}

function watchedMoments(view, names) {
  const listIndex = view.items.findIndex((item) => item.id === "sns_list");
  if (listIndex < 0) return [];
  const list = view.items[listIndex];
  const rows = [];
  for (const item of view.items.slice(listIndex + 1)) {
    if (item.depth <= list.depth) break;
    if (item.depth !== list.depth + 1 || item.role !== "AXStaticText") continue;
    const description = itemText(item);
    const author = names.filter(
      (name) =>
        description.startsWith(name + " ") ||
        description.startsWith(name + "\n"),
    );
    if (author.length !== 1) continue;
    const body = description
      .slice(author[0].length)
      .trim()
      .replace(/\s+(?:刚刚|\d+分钟前|\d+小时前|昨天)\s*$/, "");
    if (!body) continue;
    rows.push({
      id: digest(author[0] + "\n" + body),
      author: redact(author[0]),
      excerpt: redact(body.normalize("NFKC")).slice(0, 180),
      updatedAt: new Date().toISOString(),
    });
  }
  return rows;
}

class WeChatTools {
  constructor({ native, store, cropAvatar }) {
    Object.assign(this, { native, store, cropAvatar });
    this.control = native.control;
  }
  views() {
    return JSON.parse(this.control.inspectSocial());
  }
  tap(view, item, hold) {
    if (!item?.frame || item.frame.w <= 0 || item.frame.h <= 0)
      throw new Error("微信当前界面没有可核对的按钮");
    this.control.clickInput({
      pid: view.pid,
      frame: view.frame,
      hold: hold || 0,
      input: {
        x: (item.frame.x + item.frame.w / 2 - view.frame.x) / view.frame.w,
        y: (item.frame.y + item.frame.h / 2 - view.frame.y) / view.frame.h,
      },
    });
  }
  mainView() {
    const view = this.views().find(
      (view) => button(view, "发现") && button(view, "通讯录"),
    );
    if (!view) throw new Error("请先打开微信主窗口");
    return view;
  }
  async openMoments() {
    const main = this.mainView();
    this.control.focus(main);
    await this.native.sleep(300);
    if (!has(main, "sns_list")) {
      const discover = this.mainView();
      if (!button(discover, "朋友圈")) {
        this.tap(discover, button(discover, "发现"));
        await this.native.sleep(350);
      }
      const panel = this.mainView();
      this.tap(panel, button(panel, "朋友圈"));
      await this.native.sleep(400);
    }
    const feed = this.mainView();
    if (!has(feed, "sns_list"))
      throw new Error("微信朋友圈尚未打开，请稍后再试");
    return feed;
  }
  async scanMoments() {
    const settings = this.store.data.settings.wechatTools;
    if (!settings.watchEnabled || !settings.watchNames.length)
      throw new Error("请先开启指定好友动态并保存名单");
    const feed = await this.openMoments();
    const candidates = watchedMoments(feed, settings.watchNames);
    const added = this.store.recordWatchedMoments(candidates);
    return { found: candidates.length, added };
  }
  scanIdle() {
    const settings = this.store.data.settings.wechatTools;
    if (!settings.watchEnabled || !settings.watchNames.length) return;
    if (Date.now() - (this.lastIdleScan || 0) < 60_000) return;
    this.lastIdleScan = Date.now();
    const feed = this.views().find((view) => has(view, "sns_list"));
    if (feed)
      this.store.recordWatchedMoments(
        watchedMoments(feed, settings.watchNames),
      );
  }
  async openEditor({ text, kind }) {
    const body = String(text || "").trim();
    if (kind === "text" && !body) throw new Error("请先写朋友圈正文");
    if (body.length > 1500) throw new Error("朋友圈正文最多 1500 字");
    const draft = this.store.recordMomentDraft(body, kind);
    const view = await this.openMoments();
    this.tap(view, button(view, "发表"), kind === "text" ? 1200 : 0);
    if (kind === "media")
      return { draft, message: "已打开微信选图；可以从回响复制正文" };
    for (let tries = 0; tries < 5; tries++) {
      await this.native.sleep(220);
      const editor = this.views().find(
        (win) =>
          win.title === "朋友圈" &&
          button(win, "谁可以看") &&
          button(win, "发表"),
      );
      if (!editor) continue;
      this.control.writeMoment({ ...editor, text: body });
      return { draft, message: "已填入微信编辑器，请核对可见范围后发表" };
    }
    throw new Error("未识别到朋友圈编辑器，草稿已保留，可复制后粘贴");
  }
  async readProfile() {
    if (!this.store.data.settings.wechatTools.profileEnabled)
      throw new Error("请先开启联系人画像");
    const view = this.views().find(
      (entry) => has(entry, "display_name_text") && has(entry, "head_view_"),
    );
    if (!view) throw new Error("请先在微信通讯录中点开一位联系人");
    const { avatarFrame, ...profile } = profileFromAX(view);
    let avatar = "";
    if (
      this.control.screenTrusted() &&
      avatarFrame?.w > 0 &&
      avatarFrame?.h > 0
    ) {
      try {
        const shot = JSON.parse(
          await this.control.capture({ windowId: view.windowId }),
        );
        const after = this.views().find(
          (win) => win.windowId === view.windowId,
        );
        if (
          after &&
          itemText(
            after.items.find((item) => item.id === "display_name_text"),
          ) ===
            itemText(view.items.find((item) => item.id === "display_name_text"))
        )
          avatar = this.cropAvatar(shot, view.frame, avatarFrame);
      } catch {
        /* A missing preview must not block the text profile. */
      }
    }
    const previous = this.store.data.wechatRecords.profiles.find(
      (entry) => entry.id === profile.id,
    );
    return this.store.recordProfile({
      ...profile,
      avatar,
      history: previous?.history || [],
    });
  }
  async learnProfile() {
    const settings = this.store.data.settings.wechatTools;
    if (!settings.profileEnabled || !settings.profileHistoryEnabled)
      throw new Error("请先开启画像与聊天学习并保存设置");
    const { active } = discoverFromAX(JSON.parse(this.control.inspect()));
    if (!active?.sessionId || active.kind !== "private")
      throw new Error("请在微信聊天页打开一段身份明确的私聊");
    const capture = await this.native.request("capture", {
      windowId: active.windowId,
    });
    const snapshot = parseSnapshot(capture, active);
    if (!snapshot.titleVerified) throw new Error("微信聊天已切换，请重新读取");
    return this.learnFromSnapshot(active, snapshot.messages, true);
  }
  learnFromSnapshot(active, messages, explicit = false) {
    const settings = this.store.data.settings.wechatTools;
    if (
      !settings.profileEnabled ||
      !settings.profileHistoryEnabled ||
      active.kind !== "private"
    )
      return null;
    const saved = this.store.memoryFor(active.sessionId);
    const history = historyEvidence([...(saved.messages || []), ...messages]);
    const name = redact(active.expectedTitle);
    const id = digest("chat:" + active.sessionId);
    const profiles = this.store.data.wechatRecords.profiles;
    const profile = profiles.find((p) => p.id === id) || {
      id,
      name,
      avatar: "",
      signature: "",
      categories: ["待确认"],
      source: "私聊自述",
    };
    if (!history.length && !profile.history?.length)
      return explicit ? this.store.recordProfile(profile) : null;
    const combined = [
      ...new Map(
        [...(profile.history || []), ...history].map((entry) => [
          entry.text,
          entry,
        ]),
      ).values(),
    ].slice(-6);
    if (JSON.stringify(combined) === JSON.stringify(profile.history))
      return profile;
    return this.store.recordProfile({
      ...profile,
      history: combined,
      categories: [...new Set(combined.flatMap((entry) => entry.categories))],
    });
  }
  async openContacts() {
    const main = this.mainView();
    this.control.focus(main);
    await this.native.sleep(300);
    const current = this.mainView();
    if (!has(current, "contact_list"))
      this.tap(current, button(current, "通讯录"));
  }
  async openChats() {
    const main = this.mainView();
    this.control.focus(main);
    await this.native.sleep(300);
    const current = this.mainView();
    if (!has(current, "session_list"))
      this.tap(current, button(current, "WeChat") || button(current, "微信"));
  }
  async openChatsForSummary() {
    const before = this.control.frontmostPID();
    const main = this.mainView();
    this.native.navigating = true;
    try {
      await this.openChats();
      await this.native.sleep(350);
    } finally {
      try {
        if (before && before !== main.pid)
          this.control.restoreFocus({ pid: before });
      } finally {
        this.native.navigating = false;
      }
    }
  }
}

module.exports = {
  WeChatTools,
  profileFromAX,
  watchedMoments,
  historyEvidence,
};
