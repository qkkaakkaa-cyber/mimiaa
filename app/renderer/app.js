(() => {
  "use strict";
  const api = window.huixiang,
    $ = (s) => document.querySelector(s),
    root = $("#app");
  const paths = {
    wave: "M3 10v4m4-8v12m5-15v18m5-15v12m4-8v4",
    home: "m3 10 9-7 9 7v10a1 1 0 0 1-1 1h-5v-7H9v7H4a1 1 0 0 1-1-1z",
    chat: "M21 11.5a8.5 8.5 0 0 1-8.5 8.5H4l-2 2v-10A8.5 8.5 0 1 1 21 11.5ZM7 9h9M7 13h6",
    book: "M3 4h6a3 3 0 0 1 3 3v14a4 4 0 0 0-4-3H3Zm18 0h-6a3 3 0 0 0-3 3v14a4 4 0 0 1 4-3h5Z",
    sliders: "M4 5h16M4 12h16M4 19h16M8 3v4m8 3v4m-6 3v4",
    windows: "M3 3h18v18H3ZM3 8h18M8 8v13",
    clock: "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18Zm0 4v5l3 2",
    folder: "M3 6h6l2 2h10v12H3Z",
    pause: "M8 5v14M16 5v14",
    play: "m8 4 12 8-12 8Z",
    send: "m3 3 19 9-19 9 4-9Zm4 9h15",
    sparkles:
      "m12 3 2.6 6.4L21 12l-6.4 2.6L12 21l-2.6-6.4L3 12l6.4-2.6ZM20 2v4m-2-2h4",
    plus: "M12 4v16M4 12h16",
    close: "m6 6 12 12M6 18 18 6",
    refresh:
      "M20 7v5h-5M4 17v-5h5M5.5 7a7 7 0 0 1 12-2L20 8M4 16l2.5 3a7 7 0 0 0 12-2",
    check: "m5 12 4 4L19 6",
    arrow: "M5 12h14m-6-6 6 6-6 6",
    scan: "M8 3H3v5m13-5h5v5M3 16v5h5m13-5v5h-5M4 12h16",
    shield: "m12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6Zm-4 9 3 3 5-6",
    hand: "M8 13V5a2 2 0 0 1 4 0v6-7a2 2 0 0 1 4 0v8-5a2 2 0 0 1 4 0v8c0 4-3 7-7 7h-1c-2 0-3-1-4-2l-5-6a2 2 0 0 1 3-3l2 2",
    monitor: "M3 3h18v14H3Zm5 18h8m-4-4v4",
    edit: "m15 4 5 5M4 20l4-1L21 6l-5-5L3 14Z",
    trash: "M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7m4-7v7",
    key: "M15 4a5 5 0 1 1-2 9l-8 8H2v-3l8-8a5 5 0 0 1 5-6Z",
    info: "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18Zm0 7v7m0-10v.1",
  };
  const icon = (n) =>
    `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${paths[n] || paths.chat}"/></svg>`;
  function icons() {
    root.querySelectorAll("[data-icon]").forEach((el) => {
      el.innerHTML = icon(el.dataset.icon);
    });
  }
  const esc = (x) =>
    String(x ?? "").replace(
      /[&<>"']/g,
      (c) =>
        ({
          "&": "&amp;",
          "<": "&lt;",
          ">": "&gt;",
          '"': "&quot;",
          "'": "&#39;",
        })[c],
    );
  let workspace,
    agent = {
      running: false,
      busy: false,
      status: "尚未连接微信",
      draft: null,
      latest: null,
    },
    page = "inbox",
    pending = false,
    demo = false,
    demoMessages = [],
    reply = "",
    noticeTimer,
    windows = [],
    permissions = null,
    capture = null,
    calibration = null,
    calStep = "title",
    selectedWindow = null,
    lastFocus = null,
    practiceMessages = [],
    socialRecords = { profiles: [], drafts: [], moments: [] },
    momentText = "",
    profileCategory = "全部";
  const titles = {
    inbox: "接待工作台",
    knowledge: "业务知识库",
    rules: "智能体设置",
    channels: "渠道连接",
    logs: "接待记录",
    wechatTools: "微信工具",
  };
  function notify(text) {
    $("#notice").textContent = text;
    $("#notice").hidden = false;
    clearTimeout(noticeTimer);
    noticeTimer = setTimeout(() => ($("#notice").hidden = true), 5000);
  }
  async function action(fn) {
    if (pending) return;
    pending = true;
    updateChrome();
    try {
      await fn();
    } catch (e) {
      notify(e.message || "操作失败");
    } finally {
      pending = false;
      updateChrome();
    }
  }
  async function reload() {
    const data = await api.load();
    workspace = data.workspace;
    agent = data.agent;
    return data;
  }
  function intro(title, sub, side = "") {
    return `<section class="e-intro"><div><h1>${title}</h1><p>${sub}</p></div>${side}</section>`;
  }
  function updateChrome() {
    if (!workspace) return;
    $("#page-title").textContent = titles[page];
    root.querySelectorAll("[data-page]").forEach((b) => {
      b.classList.toggle("e-active", b.dataset.page === page);
      b.setAttribute(
        "aria-current",
        b.dataset.page === page ? "page" : "false",
      );
    });
    $("#run-status").innerHTML =
      `<span class="e-dot"></span>${demo ? "示例演示" : agent.running ? "AI 接待中" : "接待未开启"}`;
    $("#run-button").innerHTML =
      icon(agent.running ? "pause" : "play") +
      (agent.running ? "暂停接待" : "开始接待");
    $("#run-button").classList.toggle("e-primary", !agent.running);
    $("#run-button").disabled =
      !agent.running && (pending || agent.busy || demo);
    $("#footer-state").textContent = demo
      ? "演示模式 · 不会发送真实消息"
      : agent.status;
    $("#demo-banner").hidden = !demo;
    root
      .querySelectorAll("[data-needs-idle]")
      .forEach((b) => (b.disabled = pending || agent.busy));
    root
      .querySelectorAll("[data-needs-draft]")
      .forEach(
        (b) => (b.disabled = pending || agent.busy || (!demo && !agent.draft)),
      );
  }
  function welcome() {
    const connected =
        !!workspace.settings.windowId && !!workspace.settings.expectedTitle,
      knowledge = workspace.faqs.some((f) => f.enabled);
    return (
      intro(
        "让每一份咨询，都有回应。",
        "从一段微信对话开始，把重复的解释交给微响。",
      ) +
      `<div class="e-pagebody"><section class="welcome"><div><div class="welcome-symbol">${icon("chat")}</div><h2>你的接待助手，准备就绪。</h2><p>连接电脑上的微信，导入业务资料，让 AI 理解客户需求。先确认草稿，再按需开启自动回复。</p><div class="welcome-actions"><button class="e-button e-primary" data-page="channels">${icon("windows")}${connected ? "查看连接" : "连接微信窗口"}</button><button class="e-button" data-action="enter-demo">先体验一下 ${icon("arrow")}</button></div></div><div>${[
        {
          name: "连接微信窗口",
          sub: "指定接待对象与窗口区域",
          done: connected,
        },
        {
          name: "添加业务资料",
          sub: "写下服务介绍和常见问答",
          done: knowledge,
        },
        { name: "开始接待", sub: "先从人工确认草稿开始", done: agent.running },
      ]
        .map(
          (s, i) =>
            `<div class="setup-step ${s.done ? "done" : ""}"><span class="step-no">${s.done ? icon("check") : i + 1}</span><span>${s.name}<small>${s.sub}</small></span></div>`,
        )
        .join(
          "",
        )}</div></section><div class="quiet-grid"><section class="e-section"><h3>${icon("shield")} 你掌握接待边界</h3><p>AI 不确定时留给你处理。关闭窗口、锁屏或休眠时，接待自动暂停。</p></section><section class="e-section"><h3>${icon("book")} 先用自己的资料</h3><p>常见问答无需 AI 密钥。接入模型后，还可以生成需要人工确认的回复草稿。</p></section></div></div>`
    );
  }
  const demoSnapshot = {
    messages: [
      { role: "in", text: "你好，你们周末营业吗？" },
      { role: "out", text: "您好，欢迎咨询。请问您想了解哪方面的服务？" },
      { role: "in", text: "周六下午能过去当面了解吗？" },
    ],
  };
  function inbox() {
    const s = workspace.settings,
      r = s.reception,
      ready = agent.discovered;
    return `<div class="assistant-home"><div class="assistant-heading"><span class="assistant-avatar ${agent.running ? "active" : ""}">${icon("wave")}</span><div><h1>${agent.running ? (agent.activityPaused ? "自动接待暂时暂停" : "我来照看消息") : "你的 AI 接待同事"}</h1><p>${ready ? "微信已自动连接" : "打开微信，开始接待"} · ${esc(s.identity.name)}</p></div><span class="e-tag ${workspace.hasApiKey ? "e-green" : ""}">${workspace.hasApiKey ? "AI 已连接" : "AI 待连接"}</span></div><section class="reception-card"><div class="reception-title"><span class="e-dot"></span>${agent.running ? "正在接待" : "准备接待"}<span>${s.mode === "auto" ? "自动发送" : "先准备草稿"}</span></div><h2>聊天还在微信里。<br>AI 在一旁帮你接待。</h2><p>${s.away?.enabled ? "结合聊天上下文自然接话，有事帮你记下来。" : "自动发现新的私聊和群聊，结合上下文与业务资料回复。"}</p><button class="e-button e-primary start-reception" data-action="toggle-run" ${!agent.running && (pending || agent.busy) ? "disabled" : ""}>${icon(agent.running ? "pause" : "play")}${agent.running ? "暂停接待" : "开启微信接待"}</button><div class="reception-footnote">${esc(agent.status)}${agent.running && agent.queueSize ? ` · 待核对 ${agent.queueSize} 段` : ""}</div></section><section class="away-card"><div class="e-sectionhead"><div><h2>睡觉代班 · 闲聊</h2><small>${s.away?.enabled ? "老板休息中，AI 替你接话、记事" : "开启后，先说明 AI 身份，再接话和记留言"}</small></div><button class="e-button e-small ${s.away?.enabled ? "e-primary" : ""}" data-action="toggle-away">${s.away?.enabled ? "已开启 · 关闭" : "开启"}</button></div>${s.away?.enabled ? `<p>${esc(s.away.greeting)}</p>` : ""}</section><section class="scope-card"><div class="e-sectionhead"><h2>接待范围</h2><button class="text-button" data-page="rules">调整 ${icon("arrow")}</button></div><div class="scope-chips"><span class="scope-chip ${r.privateChats ? "enabled" : ""}">${icon("chat")}私聊 ${r.privateChats ? "已开启" : "已关闭"}</span><span class="scope-chip ${r.groupChats ? "enabled" : ""}">${icon("windows")}群聊 ${r.groupChats ? (r.mentionName ? "仅 @我时" : "待填群昵称") : "已关闭"}</span></div><div class="assistant-stats"><span><strong>${agent.overview?.privateCount || 0}</strong><small>今日联系人数</small></span><span><strong>${agent.overview?.repliesCount || 0}</strong><small>今日已回复</small></span><span><strong>${agent.tasks?.length || 0}</strong><small>需要你接手</small></span></div></section>${agent.draft ? `<section class="e-section review-card"><div class="e-sectionhead"><h2>${esc(agent.activeTitle || "待确认回复")}</h2><span class="e-tag">人工确认</span></div><textarea class="e-editor" id="reply-input">${esc(reply || agent.draft.text)}</textarea><p>${esc(agent.analysis?.reason || "确认后发送到原生微信")}</p><div class="control-row end"><button class="e-button e-primary" data-action="confirm-send" data-needs-draft>确认发送</button></div></section>` : ""}<section class="daily-contacts"><div class="e-sectionhead"><h2>今日来访 · ${esc(agent.overview?.day || "")}</h2><button class="text-button" data-action="daily-summary">核心总结 ${icon("arrow")}</button></div><small>另有 ${agent.overview?.groupCount || 0} 个群聊 · 仅统计实际识别的接待消息</small>${agent.overview?.items?.length ? agent.overview.items.map((c) => `<article class="daily-row"><div><strong>${esc(c.title)}</strong><span>${c.kind === "group" ? "群聊" : "私聊"} · 已回 ${c.replies} 条${c.finished ? " · 已收尾" : ""}</span></div><p>${esc(c.summary)}</p></article>`).join("") : '<div class="e-empty">新的联系和回复会自动记在这里。</div>'}</section><section class="assistant-tasks"><div class="e-sectionhead"><h2>需要你时，我会叫你</h2><span class="e-tag">${agent.tasks?.length || 0}</span></div>${agent.tasks?.length ? agent.tasks.map((t) => `<article class="task-card"><div class="e-sectionhead"><strong>${esc(t.title)}</strong><span class="e-tag">${t.kind === "group" ? "群聊" : "私聊"}</span></div><p>${esc(t.summary || t.reason || "需要人工处理")}</p>${t.reply ? `<div class="task-reply">${esc(t.reply)}</div>` : ""}<button class="e-button e-small" data-review-task="${t.id}">去微信接手 ${icon("arrow")}</button></article>`).join("") : `<div class="quiet-empty">${icon("shield")}<span>暂时没有待办<small>拿不准的问题会留在这里。</small></span></div>`}</section><div class="assistant-bottom"><button class="e-button" data-action="practice-open">${icon("sparkles")}先和 AI 试聊</button><button class="e-button" data-action="retry-current">处理当前消息</button><button class="e-button" data-page="knowledge">${icon("book")}添加业务资料</button></div></div>`;
  }
  function knowledge() {
    return (
      intro(
        "先了解你的生意，再替你开口。",
        "添加自己的业务资料，让每一段接待都有依据。",
      ) +
      `<div class="e-pagebody"><section class="e-section"><div class="e-sectionhead"><h2>业务介绍</h2><small>AI 回复的事实依据</small></div><label class="e-field">告诉微响你提供什么服务<textarea id="business" rows="4" placeholder="例如：我们的服务范围、营业时间、预约方式，以及需要人工确认的事项。">${esc(workspace.settings.business)}</textarea></label><div class="control-row end"><button class="e-button e-primary" data-action="save-business">保存介绍</button></div></section><section class="e-section"><div class="e-sectionhead"><h2>业务资料 <span class="muted">${(workspace.documents || []).length}</span></h2><button class="e-button e-primary" data-action="import-document">${icon("plus")}导入资料</button></div><p>导入 TXT、Markdown、PDF 或 Word 文档，AI 会检索相关段落来回答客户。</p>${(workspace.documents || []).map((d) => `<article class="faq-row"><div class="e-sectionhead"><strong>${esc(d.name)}</strong><button class="e-iconbutton" data-remove-document="${d.id}" aria-label="移除资料">${icon("trash")}</button></div><p>${esc(d.text.slice(0, 160))}…</p><small>${d.text.length.toLocaleString()} 字 · 已加入知识库</small></article>`).join("") || '<div class="e-empty">上传服务说明、产品手册、政策或接待流程。</div>'}</section><section class="e-section"><div class="e-sectionhead"><h2>常见问答 <span class="muted">${workspace.faqs.length}</span></h2><button class="e-button e-primary" data-action="add-faq">${icon("plus")}添加问答</button></div>${workspace.faqs.length ? workspace.faqs.map((f) => `<article class="faq-row"><div class="e-sectionhead"><strong>${esc(f.question)}</strong><span class="e-tag ${f.enabled ? "e-green" : ""}">${f.enabled ? "已启用" : "已停用"}</span></div><p>${esc(f.answer)}</p><div class="faq-meta"><span>${f.autoSend ? "已授权自动发送" : "仅生成草稿"}</span><span>${esc(f.keywords.join(" · "))}</span><div class="control-row"><button class="e-iconbutton" data-edit-faq="${f.id}" aria-label="编辑问答">${icon("edit")}</button><button class="e-iconbutton" data-remove-faq="${f.id}" aria-label="移除问答">${icon("trash")}</button></div></div></article>`).join("") : '<div class="e-empty">还没有业务问答。先添加客户经常问的一个问题。</div>'}</section></div>`
    );
  }
  function rules() {
    const s = workspace.settings;
    return (
      intro(
        "让 AI 像你的同事一样接待",
        "设定角色和目标，结合业务资料与上下文作出回复判断。",
        `<button class="e-button e-primary" data-action="practice-open">${icon("sparkles")}和 AI 试聊</button>`,
      ) +
      `<div class="e-pagebody"><section class="e-section"><h2>助手名片</h2><label class="e-field">AI 对外名称<input id="assistant-name" maxlength="40" value="${esc(s.identity.name)}" placeholder="例如：小林助手"></label><label class="e-field">你的行业<input id="business-industry" maxlength="100" value="${esc(s.identity.industry)}" placeholder="例如：零售、培训、餐饮、招聘"></label><p class="help-inline">介绍身份时会使用这个名字，接待记录里也会显示。</p><div class="control-row"><button class="e-button e-primary" data-action="save-identity">保存名片</button><button class="e-button" data-page="knowledge">添加业务资料</button></div></section><section class="e-section" id="ai-connection"><div class="e-sectionhead"><h2>AI 密钥</h2><span class="e-tag ${workspace.hasApiKey ? "e-green" : ""}">${workspace.hasApiKey ? "已保存" : "待设置"}</span></div><label class="e-field">API 密钥<input id="model-key" type="password" autocomplete="off" placeholder="${workspace.hasApiKey ? "留空保留当前密钥" : "粘贴你的 API 密钥"}"></label><div class="control-row"><button class="e-button e-primary e-small" data-action="save-model">保存密钥</button><button class="e-button e-small" data-action="test-model">测试连接</button><button class="text-button" data-action="get-model-key">获取 API 密钥 ${icon("arrow")}</button></div><p class="help-inline">密钥加密保存在本机。AI 服务由你的接口账户单独计费。</p>${workspace.hasApiKey ? '<details><summary>管理密钥</summary><button class="e-button e-small" data-action="clear-key">清除已保存密钥</button></details>' : ""}</section><section class="e-section"><h2>AI 性格</h2><label class="e-field">说话风格<select id="personality-preset">${[
        ["warm", "温和自然"],
        ["witty", "轻松幽默"],
        ["direct", "简洁直接"],
        ["steady", "沉稳耐心"],
      ]
        .map(
          ([id, label]) =>
            `<option value="${id}" ${s.personality.preset === id ? "selected" : ""}>${label}</option>`,
        )
        .join(
          "",
        )}</select></label><label class="e-field">补充你希望的性格<textarea id="personality-custom" rows="3" placeholder="例如：像熟悉的朋友，少客套，可以适当开玩笑。">${esc(s.personality.custom)}</textarea></label><div class="control-row end"><button class="e-button e-primary" data-action="save-personality">保存性格</button></div><div class="help-inline">隐私保护始终开启。学习历史口吻将单独提供默认关闭的入口，说明读取范围和学习结果后再启用。</div></section><section class="e-section"><h2>私聊与群聊</h2><label class="e-rule"><span>接待私聊<small>自动处理接待范围中的新咨询。</small></span><input class="e-switch" id="scope-private" type="checkbox" ${s.reception.privateChats ? "checked" : ""}></label><label class="e-rule"><span>接待群聊<small>只有明确 @你的新消息会触发回复。</small></span><input class="e-switch" id="scope-group" type="checkbox" ${s.reception.groupChats ? "checked" : ""}></label><label class="e-field">你在群里的称呼<input id="mention-name" value="${esc(s.reception.mentionName)}" placeholder="填微信里被 @ 时显示的完整昵称"></label><label class="e-field">不接待这些会话<textarea id="excluded-chats" rows="2" placeholder="每行一个完整的联系人或群名称">${esc(s.reception.excluded.join("\n"))}</textarea></label></section><section class="e-section"><h2>睡觉代班和闲聊</h2><label class="e-field">第一次替你接话时说什么<textarea id="away-greeting" rows="4">${esc(s.away.greeting)}</textarea></label><div class="help-inline">同一次代班中，每段聊天只发送一次开场白；后续自然接话，留言留到助手待办。</div><button class="e-button" data-action="save-away" style="margin-top:12px">保存代班话术</button></section><section class="e-section"><h2>角色与接待目标</h2><div class="settings-grid"><label class="e-field full">你希望它是谁<textarea id="persona" rows="2">${esc(s.persona)}</textarea></label><label class="e-field full">希望它完成什么<textarea id="goal" rows="2">${esc(s.goal)}</textarea></label><label class="e-field">接待方式<select id="reply-mode"><option value="assist" ${s.mode === "assist" ? "selected" : ""}>辅助草稿 · 确认后发送</option><option value="auto" ${s.mode === "auto" ? "selected" : ""}>AI 自动接待 · 回复、追问或转人工</option></select></label><label class="e-field">检查新消息的间隔<select id="interval">${[6, 8, 10, 15, 30, 60].map((v) => `<option value="${v}" ${s.interval === v ? "selected" : ""}>${v} 秒</option>`).join("")}</select></label></div><label class="e-rule"><span>记住这段会话的需求<small>在本机保存最近聊天文字和需求摘要，后续生成回复时使用。</small></span><input class="e-switch" id="remember" type="checkbox" ${s.rememberConversations ? "checked" : ""}></label><label class="e-rule"><span>报价和承诺交给我确认<small>涉及价格、付款、退款、合同等内容时，保留草稿供人工处理。</small></span><input class="e-switch" id="confirm-promises" type="checkbox" ${s.rules.confirmPromises ? "checked" : ""}></label><div class="inline-note">${icon("info")}<span>AI 根据资料解答、澄清需求；资料不足时转人工。开启时也会接待主列表中今天仍未读的消息。</span></div><div class="control-row end"><button class="e-button e-primary" data-action="save-rules">保存智能体设置</button></div></section></div>`
    );
  }
  function channels() {
    return (
      intro(
        "微信已在，助手就在。",
        "自动识别原生微信，无需手动选择窗口或填写聊天名称。",
      ) +
      `<div class="e-pagebody"><section class="e-section"><div class="e-sectionhead"><h2>连接微信</h2><span class="e-tag ${agent.discovered ? "e-green" : ""}">${agent.discovered ? "已连接" : "待检查"}</span></div><p>保持电脑微信登录。微响会持续发现新消息，空闲时可以自动恢复窗口并返回聊天列表。</p><button class="e-button e-primary" data-action="discover" style="margin-top:16px">${icon("scan")}自动检查微信</button><button class="e-button" data-action="local-check" style="margin-top:10px">本机读取自检</button><div class="help-inline">${agent.discovered ? `已发现 ${agent.sessions?.length || 0} 段会话。` : "检查只读取本机界面，不发送消息。"} 接待使用微信主会话列表。锁屏时接待暂停。</div></section><section class="e-section"><div class="e-sectionhead"><h2>系统权限</h2><button class="e-button e-small" data-action="refresh-permissions">刷新</button></div>${[
        {
          id: "accessibility",
          name: "辅助功能",
          help: "识别会话列表、切换聊天和输入回复",
        },
        {
          id: "screen",
          name: "屏幕录制",
          help: "在本地核对消息内容与发送结果",
        },
      ]
        .map(
          (p) =>
            `<div class="permission-row"><div><strong>${p.name}</strong><small>${p.help}</small></div><span data-permission-status="${p.id}" class="e-tag ${permissions?.[p.id] ? "e-green" : ""}">${permissions?.[p.id] ? "已授权" : permissions ? "未授权" : "待检查"}</span><button class="e-button e-small" data-permission="${p.id}">${permissions?.[p.id] ? "查看设置" : "前往授权"}</button></div>`,
        )
        .join(
          "",
        )}<div class="help-inline">只为“微响”授权。返回软件后自动刷新状态。</div></section><section class="e-section"><h2>平台</h2><div class="future-channel"><span>微信 · 私聊与群聊</span><span class="e-tag e-green">本机接待</span></div><div class="future-channel"><span>WhatsApp / Telegram</span><span class="e-tag">暂未接入</span></div></section></div>`
    );
  }
  function logs() {
    const reports = agent.conversationReports || [];
    const details = (label, value) =>
      `<div class="report-detail"><dt>${label}</dt><dd>${esc(value)}</dd></div>`;
    return (
      intro(
        "每次对话，留下核心。",
        "按联系人列出诉求、下一步和需要你处理的事。明确告别后标记结束，10 分钟无新对话则保留本轮小结。",
      ) +
      `<div class="e-pagebody"><section class="e-section conversation-reports"><div class="e-sectionhead"><h2>对话核心 · 最近14天</h2><button class="e-button e-small" data-action="refresh-logs">${icon("refresh")}刷新</button></div><button class="e-button e-small" data-action="summarize-current">选择聊天并总结</button><p class="help-inline">在微响选联系人，自动切到微信读取本轮对话。</p>${reports.length ? reports.map((r) => `<article class="conversation-report"><div class="e-sectionhead"><strong>${esc(r.title)}</strong><span class="e-tag ${r.ownerTodo.length ? "e-warm" : ""}">${r.finished ? "已结束" : r.idle ? "本轮小结" : "进行中"}</span></div><time>${new Date(r.updatedAt).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" })}</time><p class="report-core">${esc(r.core)}</p>${r.assistantName ? `<small>接待助手 · ${esc(r.assistantName)}</small>` : ""}<dl>${details("对方想要", r.intent)}${details("下一步", r.nextSteps.join("；") || "暂无明确下一步")}${details("需要你处理", r.ownerTodo.join("；") || "暂无待办")}</dl></article>`).join("") : '<div class="e-empty">AI 接待后，会在这里逐人提取对话核心。纯闲聊也会注明主题，不凭空生成待办。</div>'}</section><details class="e-section"><summary>运行记录</summary>${workspace.events.length ? workspace.events.map((e) => `<div class="log-row"><time datetime="${esc(e.time)}">${new Date(e.time).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" })}</time><span class="e-tag ${e.type === "warning" ? "e-warm" : ""}">${{ start: "开始", sent: "已发送", warning: "需检查", handoff: "待处理", draft: "草稿" }[e.type] || "记录"}</span><span>${esc(e.message)}</span></div>`).join("") : '<div class="e-empty">暂无运行记录。</div>'}</details></div>`
    );
  }
  function wechatTools() {
    const settings = workspace.settings.wechatTools;
    const profiles = socialRecords.profiles;
    const categories = [
      "全部",
      ...new Set(profiles.flatMap((p) => p.categories)),
    ];
    const visibleProfiles =
      profileCategory === "全部"
        ? profiles
        : profiles.filter((p) => p.categories.includes(profileCategory));
    return `<div class="e-pagebody wechat-tools">
      <div class="e-sectionhead"><h1>微信工具</h1><button class="e-button e-small" data-action="wechat-chats" data-needs-idle>返回微信聊天</button></div>
      <section class="e-section"><div class="e-sectionhead"><h2>发朋友圈</h2><button class="e-button e-small" data-action="wechat-feed" data-needs-idle>查看朋友圈</button></div>
      <label class="e-field">正文<textarea id="moment-text" class="e-editor" rows="3" maxlength="1500" placeholder="写下想分享的内容">${esc(momentText)}</textarea></label>
      <div class="control-row"><button class="e-button e-primary e-small" data-action="wechat-moment-text" data-needs-idle>去微信检查并发表</button><button class="e-button e-small" data-action="wechat-moment-media" data-needs-idle>选图片或视频</button><button class="e-button e-small" data-action="wechat-moment-copy">复制正文</button></div>
      ${
        socialRecords.drafts.length
          ? `<details class="social-history"><summary>本机草稿 · ${socialRecords.drafts.length}</summary>${socialRecords.drafts
              .slice(0, 20)
              .map(
                (draft) =>
                  `<article class="social-row"><span>${esc(draft.body || "图片或视频草稿")}</span><button class="text-button" data-moment-draft="${esc(draft.id)}">使用</button></article>`,
              )
              .join("")}</details>`
          : ""
      }</section>
      <section class="e-section"><h2>指定好友动态</h2><label class="social-toggle"><input type="checkbox" id="wechat-watch-enabled" ${settings.watchEnabled ? "checked" : ""}> 追踪指定好友</label>
      <label class="e-field">微信显示名称，每行一位<textarea id="wechat-watch-names" rows="2">${esc(settings.watchNames.join("\n"))}</textarea></label>
      <div class="control-row"><button class="e-button e-small" data-action="wechat-tools-save">保存设置</button><button class="e-button e-small" data-action="wechat-scan" data-needs-idle>查看指定好友动态</button></div>
      <p class="help-inline">独立朋友圈窗口打开时，空闲会检查可见动态。点赞在微信中点选。</p>
      ${(socialRecords.moments || [])
        .slice(0, 12)
        .map(
          (item) =>
            `<article class="social-row"><strong>${esc(item.author)}</strong><p>${esc(item.excerpt)}</p></article>`,
        )
        .join("")}</section>
      <section class="e-section"><h2>联系人画像</h2><label class="social-toggle"><input type="checkbox" id="wechat-profile-enabled" ${settings.profileEnabled ? "checked" : ""}> 启用联系人画像</label><label class="social-toggle"><input type="checkbox" id="wechat-profile-history" ${settings.profileHistoryEnabled ? "checked" : ""}> 从私聊记录学习</label><p class="help-inline">开启后从已保存和当前可见的私聊找对方的明确自述，在本机保留分类及依据。</p>
      <p class="help-inline">在微信通讯录选中联系人后，读取可见昵称、头像和个性签名。类别由昵称和签名中的业务线索得出。</p>
      <div class="control-row"><button class="e-button e-small" data-action="wechat-contacts" data-needs-idle>打开通讯录</button><button class="e-button e-primary e-small" data-action="wechat-read-profile" data-needs-idle>读取当前联系人</button><button class="e-button e-small" data-action="wechat-learn-profile" data-needs-idle>学习当前私聊</button></div>
      <label class="e-field">分类<select id="profile-category">${categories.map((category) => `<option ${category === profileCategory ? "selected" : ""}>${esc(category)}</option>`).join("")}</select></label>
      ${visibleProfiles.length ? visibleProfiles.map((profile) => `<article class="social-profile">${/^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(profile.avatar) ? `<img src="${esc(profile.avatar)}" alt="头像">` : ""}<div><strong>${esc(profile.name)}</strong><div class="social-tags">${profile.categories.map((category) => `<span class="e-tag">${esc(category)}</span>`).join("")}</div><p>${esc(profile.signature || (profile.source ? "来源：私聊自述" : "微信资料未显示个性签名"))}</p>${profile.history?.length ? `<ul class="profile-evidence">${profile.history.map((entry) => `<li>${esc(entry.text)}</li>`).join("")}</ul>` : ""}</div></article>`).join("") : '<div class="e-empty">这里会保存已读取的联系人及其分类。</div>'}</section></div>`;
  }
  function render() {
    if (!workspace) return;
    $("#content").innerHTML = {
      inbox,
      knowledge,
      rules,
      channels,
      logs,
      wechatTools,
    }[page]();
    icons();
    updateChrome();
  }
  function modal(title, html, wide = false) {
    lastFocus = document.activeElement;
    $("#modal-title").textContent = title;
    $("#modal-content").innerHTML = html;
    $(".e-modal").classList.toggle("wide", wide);
    $("#overlay").hidden = false;
    icons();
    $("#overlay button").focus();
  }
  function closeModal() {
    $("#overlay").hidden = true;
    lastFocus?.focus();
  }
  function faqForm(id) {
    const f = workspace.faqs.find((x) => x.id === id) || {
      question: "",
      answer: "",
      keywords: [],
      enabled: true,
      autoSend: false,
    };
    modal(
      id ? "编辑问答" : "添加常见问答",
      `<form id="faq-form" data-id="${esc(id || "")}"><label class="e-field">客户常问的问题<input id="faq-question" required maxlength="500" value="${esc(f.question)}" placeholder="例如：周末营业吗？"></label><label class="e-field">确定的回答<textarea id="faq-answer" required maxlength="2000" rows="4" placeholder="填写真实、可直接发给客户的答案">${esc(f.answer)}</textarea></label><label class="e-field">匹配关键词<input id="faq-keywords" value="${esc(f.keywords.join("，"))}" placeholder="例如：营业时间，周末营业"><span class="field-note">用逗号分隔；多个答案同时匹配时会交给你确认。</span></label><label class="checkline"><input id="faq-enabled" type="checkbox" ${f.enabled ? "checked" : ""}><span>启用这条问答</span></label><label class="checkline"><input id="faq-auto" type="checkbox" ${f.autoSend ? "checked" : ""}><span>允许自动发送此答案<small>仅在自动模式下生效。请先确认答案适用于日常接待。</small></span></label><div class="e-modal-actions"><button type="button" class="e-button" data-action="close-modal">取消</button><button class="e-button e-primary" type="submit">保存问答</button></div></form>`,
    );
  }
  function showCalibration() {
    const c = calibration;
    modal(
      "标记微信窗口区域",
      `<div class="cal-options">${[
        ["title", "① 会话标题"],
        ["messages", "② 消息区域"],
        ["composer", "③ 输入框"],
        ["input", "④ 输入位置"],
      ]
        .map(
          ([id, label]) =>
            `<button class="e-button e-small ${id === calStep ? "active" : ""}" data-cal-step="${id}">${label}</button>`,
        )
        .join(
          "",
        )}</div><div class="calibration" id="calibration"><img src="data:image/png;base64,${capture.image}" alt="选定微信窗口的本机截图" draggable="false"><div id="cal-shapes"></div></div><div class="cal-help" id="cal-help"></div><div class="e-modal-actions"><button class="e-button" data-action="close-modal">取消</button><button class="e-button e-primary" data-action="apply-calibration">保存标记</button></div>`,
      true,
    );
    drawCalibration();
    bindCalibration();
  }
  function drawCalibration() {
    const labels = {
      title: "会话标题",
      messages: "消息区域",
      composer: "输入框",
    };
    $("#cal-shapes").innerHTML =
      Object.entries(labels)
        .map(([key, label]) => {
          const r = calibration[key];
          return `<div class="cal-box ${key}" style="left:${r.x * 100}%;top:${r.y * 100}%;width:${r.w * 100}%;height:${r.h * 100}%"><span class="cal-label">${label}</span></div>`;
        })
        .join("") +
      `<div class="cal-point" style="left:${calibration.input.x * 100}%;top:${calibration.input.y * 100}%"></div>`;
    $("#cal-help").textContent =
      calStep === "input"
        ? "在输入框的空白文字区域单击，设置输入位置。"
        : "拖动框选" +
          labels[calStep] +
          "。标题只包含客户名称；输入框不包含工具栏和“发送”按钮。";
  }
  function bindCalibration() {
    const surface = $("#calibration");
    let origin = null;
    const point = (e) => {
      const b = surface.getBoundingClientRect();
      return {
        x: Math.max(0, Math.min(1, (e.clientX - b.left) / b.width)),
        y: Math.max(0, Math.min(1, (e.clientY - b.top) / b.height)),
      };
    };
    surface.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      if (calStep === "input") {
        calibration.input = point(e);
        drawCalibration();
        return;
      }
      origin = point(e);
      surface.setPointerCapture(e.pointerId);
    });
    surface.addEventListener("pointermove", (e) => {
      if (!origin) return;
      const p = point(e);
      calibration[calStep] = {
        x: Math.min(origin.x, p.x),
        y: Math.min(origin.y, p.y),
        w: Math.abs(p.x - origin.x),
        h: Math.abs(p.y - origin.y),
      };
      drawCalibration();
    });
    surface.addEventListener("pointerup", () => (origin = null));
    surface.addEventListener("pointercancel", () => (origin = null));
  }
  let refreshingPermissions = false;
  async function permissionRefresh() {
    if (refreshingPermissions) return;
    refreshingPermissions = true;
    try {
      permissions = await api.permissions();
      if (page === "channels") {
        root.querySelectorAll("[data-permission-status]").forEach((b) => {
          const granted = permissions[b.dataset.permissionStatus];
          b.textContent = granted ? "已授权" : "未授权";
          b.classList.toggle("e-green", granted);
        });
        root
          .querySelectorAll("[data-permission]")
          .forEach(
            (b) =>
              (b.textContent = permissions[b.dataset.permission]
                ? "查看设置"
                : "前往授权"),
          );
      }
    } catch (error) {
      if (page === "channels")
        root.querySelectorAll("[data-permission-status]").forEach((b) => {
          b.textContent = "检测失败";
          b.classList.remove("e-green");
        });
      throw error;
    } finally {
      refreshingPermissions = false;
    }
  }
  window.addEventListener("focus", () => {
    if (page === "channels")
      permissionRefresh().catch((e) => notify(e.message));
  });
  document.addEventListener("visibilitychange", () => {
    if (page === "channels" && !document.hidden)
      permissionRefresh().catch((e) => notify(e.message));
  });
  setInterval(() => {
    if (
      page === "channels" &&
      document.hasFocus() &&
      (!permissions?.accessibility || !permissions?.screen)
    )
      permissionRefresh().catch(() => {});
  }, 3000);
  async function saveModel({ required = false } = {}) {
    const entered = $("#model-key").value.trim();
    if (!entered) {
      if (required) throw new Error("请先粘贴 API 密钥");
      return true;
    }
    const result = await api.saveKey(entered);
    await reload();
    render();
    return result.persisted;
  }
  root.addEventListener("click", (e) => {
    const b = e.target.closest("button");
    if (!b || b.disabled) return;
    if (b.dataset.momentDraft) {
      momentText =
        socialRecords.drafts.find((draft) => draft.id === b.dataset.momentDraft)
          ?.body || "";
      $("#moment-text").value = momentText;
      return;
    }
    if (b.dataset.page) {
      page = b.dataset.page;
      if (page !== "inbox" && demo) {
        demo = false;
        reply = agent.draft?.text || "";
      }
      render();
      if (page === "channels") action(permissionRefresh);
      if (page === "wechatTools")
        action(async () => {
          socialRecords = await api.wechatToolsLoad();
          render();
        });
      if (page === "logs")
        action(async () => {
          await reload();
          render();
        });
      return;
    }
    if (b.dataset.reviewTask) {
      action(async () => {
        agent = await api.reviewTask(b.dataset.reviewTask);
        reply = agent.draft?.text || "";
        page = "inbox";
        render();
      });
      return;
    }
    if (b.dataset.removeDocument) {
      action(async () => {
        workspace = await api.removeDocument(b.dataset.removeDocument);
        render();
      });
      return;
    }
    if (b.dataset.editFaq) {
      faqForm(b.dataset.editFaq);
      return;
    }
    if (b.dataset.removeFaq) {
      modal(
        "移除这条问答？",
        `<p>移除后，将不再用于接待回复。</p><div class="e-modal-actions"><button class="e-button" data-action="close-modal">取消</button><button class="e-button e-primary" data-confirm-remove="${b.dataset.removeFaq}">移除问答</button></div>`,
      );
      return;
    }
    if (b.dataset.confirmRemove) {
      action(async () => {
        workspace = await api.removeFAQ(b.dataset.confirmRemove);
        closeModal();
        render();
        notify("问答已移除");
      });
      return;
    }
    if (b.dataset.permission) {
      action(async () => {
        const type = b.dataset.permission;
        if (!permissions?.[type]) await api.requestPermission(type);
        await api.openSettings(type);
        await permissionRefresh();
      });
      return;
    }
    if (b.dataset.calStep) {
      calStep = b.dataset.calStep;
      root
        .querySelectorAll("[data-cal-step]")
        .forEach((x) =>
          x.classList.toggle("active", x.dataset.calStep === calStep),
        );
      drawCalibration();
      return;
    }
    const type = b.dataset.action;
    if (type === "wechat-tools-save")
      action(async () => {
        workspace = await api.wechatToolsSettings({
          profileEnabled: $("#wechat-profile-enabled").checked,
          profileHistoryEnabled: $("#wechat-profile-history").checked,
          watchEnabled: $("#wechat-watch-enabled").checked,
          watchNames: $("#wechat-watch-names").value.split(/\n+/),
        });
        render();
        notify("微信工具设置已保存");
      });
    if (type === "wechat-feed") action(() => api.wechatMoments());
    if (type === "wechat-contacts") action(() => api.wechatContacts());
    if (type === "wechat-chats") action(() => api.wechatChats());
    if (type === "wechat-moment-copy")
      action(async () => {
        if (!momentText.trim()) throw new Error("请先写朋友圈正文");
        await api.copyMoment(momentText);
        notify("已复制朋友圈正文");
      });
    if (type === "wechat-moment-text" || type === "wechat-moment-media")
      action(async () => {
        try {
          const result = await api.wechatMomentEditor({
            text: momentText,
            kind: type.endsWith("media") ? "media" : "text",
          });
          notify(result.message);
        } finally {
          socialRecords = await api.wechatToolsLoad();
          render();
        }
      });
    if (type === "wechat-scan")
      action(async () => {
        const result = await api.wechatMomentsScan();
        socialRecords = await api.wechatToolsLoad();
        render();
        notify(
          `当前可见 ${result.found} 条指定好友动态，新记录 ${result.added} 条`,
        );
      });
    if (type === "wechat-learn-profile")
      action(async () => {
        const profile = await api.wechatLearnProfile();
        socialRecords = await api.wechatToolsLoad();
        profileCategory = "全部";
        render();
        notify(
          profile?.history?.length
            ? "已保存私聊自述及分类"
            : "暂无明确自述，已标为待确认",
        );
      });
    if (type === "wechat-read-profile")
      action(async () => {
        await api.wechatProfile();
        socialRecords = await api.wechatToolsLoad();
        profileCategory = "全部";
        render();
        notify("联系人画像已分类保存");
      });
    if (type === "practice-open") {
      practiceMessages = [];
      modal(
        "和你的 AI 接待同事试聊",
        `<p>使用当前角色和业务资料进行真实 AI 试聊。消息不会发到微信。</p><div id="practice-history" class="practice-history"><div class="e-empty">像客户一样发一句话，看看它怎么接。</div></div><label class="e-field">客户消息<textarea id="practice-input" rows="2" placeholder="例如：你们提供什么服务，怎么预约？"></textarea></label><div class="e-modal-actions"><button class="e-button e-primary" data-action="practice-send">发送试聊</button></div>`,
        true,
      );
      return;
    }
    if (type === "practice-send")
      action(async () => {
        const input = $("#practice-input"),
          text = input.value.trim();
        if (!text) throw new Error("先写一条客户咨询");
        practiceMessages.push({ role: "in", text });
        input.value = "";
        const history = $("#practice-history");
        history.innerHTML +=
          '<p class="muted" id="practice-wait">AI 正在结合资料理解需求…</p>';
        const decision = await api.practice(practiceMessages);
        if (!decision.reply) decision.reply = decision.reason;
        practiceMessages.push({ role: "out", text: decision.reply });
        history.innerHTML =
          practiceMessages
            .map(
              (m) =>
                `<div class="practice-line ${m.role === "out" ? "ai" : ""}"><small>${m.role === "out" ? "AI 接待" : "客户"}</small><p>${esc(m.text)}</p></div>`,
            )
            .join("") +
          `<div class="help-inline">${esc(decision.reason)} · ${esc(decision.sourceNames.join("、") || "需求澄清")}</div>`;
        history.scrollTop = history.scrollHeight;
      });
    if (type === "import-document")
      action(async () => {
        workspace = await api.importDocument();
        render();
      });
    if (type === "smart-layout")
      action(async () => {
        selectedWindow = Number($("#wechat-window").value);
        if (!selectedWindow) throw new Error("先选择一个微信窗口");
        notify("正在识别会话名称和聊天区域，请稍候…");
        const result = await api.smartLayout(selectedWindow);
        capture = result.capture;
        calibration = result.calibration;
        $("#expected-title").value = result.expectedTitle;
        calStep = "title";
        showCalibration();
      });
    if (type === "local-check")
      action(async () => {
        const result = await api.read();
        modal(
          "本机读取自检",
          `<p>已自动识别当前聊天和输入区域。</p><p>聊天标题核对：${result.snapshot.titleVerified ? "通过" : "未通过"}；识别到 ${result.snapshot.messages.length} 条可见文字消息。</p><div class="help-inline">截图仅在本地处理，本次未调用 AI，也未输入或发送消息。</div>`,
        );
      });
    if (type === "toggle-away")
      action(async () => {
        const wasRunning = agent.running;
        workspace = await api.saveSettings({
          ...workspace.settings,
          away: {
            ...workspace.settings.away,
            enabled: !workspace.settings.away.enabled,
          },
        });
        if (wasRunning) agent = await api.start();
        render();
        notify(
          workspace.settings.away.enabled
            ? "睡觉代班已开启；开始接待后处理新消息"
            : "睡觉代班已关闭，留言保留在待办",
        );
      });
    if (type === "save-away")
      action(async () => {
        workspace = await api.saveSettings({
          ...workspace.settings,
          away: {
            ...workspace.settings.away,
            greeting: $("#away-greeting").value,
          },
        });
        render();
        notify("代班话术已保存");
      });
    if (type === "daily-summary") {
      const report = agent.overview;
      modal(
        "今日接待核心总结",
        `<p>${esc(report?.day || "")} · ${report?.privateCount || 0} 位私聊联系人、${report?.groupCount || 0} 个群 · 已确认发送 ${report?.repliesCount || 0} 条回复</p>${report?.items?.length ? report.items.map((c) => `<article class="task-card"><strong>${esc(c.title)}</strong><p>${esc(c.summary)}</p><small>${c.finished ? "已收尾，摘要已记录" : "进行中或等待你回复"}</small></article>`).join("") : '<div class="e-empty">今天还没有实际接待记录。</div>'}`,
      );
      return;
    }
    if (type === "save-personality")
      action(async () => {
        const wasRunning = agent.running;
        workspace = await api.saveSettings({
          ...workspace.settings,
          personality: {
            ...workspace.settings.personality,
            preset: $("#personality-preset").value,
            custom: $("#personality-custom").value,
          },
        });
        if (wasRunning) agent = await api.start();
        render();
        notify("AI 性格已保存");
      });
    if (type === "retry-current")
      action(async () => {
        agent = await api.retryCurrent();
        render();
        if (agent.status.includes("已有发送记录"))
          modal(
            "核对这条代班草稿",
            `<p>聊天对象：<strong>${esc(agent.activeTitle)}</strong></p><div class="task-reply">${esc(workspace.settings.away.greeting)}</div><p>上次发送结果未确认。请只在微信仍留着这份草稿、聊天里没有这条回复时继续。</p><div class="e-modal-actions"><button class="e-button" data-action="close-modal">取消</button><button class="e-button e-primary" data-action="retry-prepared">已核对未发出，继续发送</button></div>`,
          );
        else notify(agent.status);
      });
    if (type === "retry-prepared")
      action(async () => {
        agent = await api.retryCurrent({
          confirmedPrepared: true,
          expectedTitle: agent.activeTitle,
        });
        closeModal();
        render();
        notify(agent.status);
      });
    if (type === "close-modal") {
      closeModal();
      return;
    }
    if (type === "add-faq") {
      faqForm();
      return;
    }
    if (type === "enter-demo") {
      demo = true;
      demoMessages = [];
      reply =
        "可以先为您登记周六下午的到访意向。您大约几点方便？我请同事确认接待安排后再回复您。";
      render();
      return;
    }
    if (type === "exit-demo") {
      demo = false;
      reply = agent.draft?.text || "";
      render();
      return;
    }
    if (type === "read") {
      action(async () => {
        if (demo) {
          notify("已读取示例会话");
          return;
        }
        await api.read();
        reply = "";
        render();
      });
    }
    if (type === "generate") {
      action(async () => {
        if (demo) {
          reply =
            "可以先为您登记周六下午的到访意向。您大约几点方便？我请同事确认接待安排后再回复您。";
          render();
          return;
        }
        const draft = await api.generate();
        reply = draft.text;
        render();
      });
    }
    if (type === "confirm-send") {
      if (demo) {
        if (reply.trim()) {
          demoMessages.push({ role: "out", text: reply });
          reply = "";
          render();
          notify("回复已加入演示，没有发送到微信。");
        }
        return;
      }
      if (!reply.trim()) {
        notify("请先填写回复内容");
        return;
      }
      modal(
        "确认发送到微信",
        `<p>接待对象：<strong>${esc(agent.activeTitle || workspace.settings.expectedTitle)}</strong></p><div class="e-bubble">${esc(reply)}</div><p>请确认当前微信里的接待对象和回复内容。</p><div class="e-modal-actions"><button class="e-button" data-action="close-modal">取消</button><button class="e-button e-primary" data-action="send-real">确认发送这一条</button></div>`,
      );
    }
    if (type === "send-real") {
      action(async () => {
        await api.send(reply);
        reply = "";
        closeModal();
        await reload();
        render();
        notify(agent.status);
      });
    }
    if (type === "takeover") {
      if (demo) {
        notify("演示：AI 已让出会话，你可以修改草稿。");
        $("#reply-input")?.focus();
        return;
      }
      action(async () => {
        agent = await api.stop();
        render();
        notify("你已接手，自动接待已暂停。");
      });
    }
    if (type === "toggle-run" && agent.running) {
      api
        .stop()
        .then((next) => {
          agent = next;
          render();
        })
        .catch((e) => notify(e.message));
      return;
    }
    if (type === "toggle-run") {
      action(async () => {
        agent = agent.running ? await api.stop() : await api.start();
        render();
        notify(agent.status);
      });
    }
    if (type === "save-identity")
      action(async () => {
        const wasRunning = agent.running;
        workspace = await api.saveSettings({
          ...workspace.settings,
          identity: {
            name: $("#assistant-name").value,
            industry: $("#business-industry").value,
          },
        });
        if (wasRunning) agent = await api.start();
        render();
        notify("助手名片已保存");
      });
    if (type === "save-business") {
      action(async () => {
        workspace = await api.saveSettings({
          ...workspace.settings,
          business: $("#business").value,
        });
        render();
        notify("业务介绍已保存");
      });
    }
    if (type === "save-rules") {
      action(async () => {
        workspace = await api.saveSettings({
          ...workspace.settings,
          reception: {
            privateChats: $("#scope-private").checked,
            groupChats: $("#scope-group").checked,
            mentionName: $("#mention-name").value,
            excluded: $("#excluded-chats")
              .value.split("\n")
              .map((s) => s.trim())
              .filter(Boolean),
          },
          persona: $("#persona").value,
          goal: $("#goal").value,
          rememberConversations: $("#remember").checked,
          mode: $("#reply-mode").value,
          interval: Number($("#interval").value),
          rules: {
            confirmPromises: $("#confirm-promises").checked,
            pauseOnActivity: true,
          },
        });
        render();
        notify("接待规则已保存");
      });
    }
    if (type === "get-model-key") action(() => api.getModelKey());
    if (type === "save-model")
      action(async () => {
        const saved = await saveModel({ required: true });
        notify(saved ? "AI 密钥已保存" : "密钥只保留到本次退出");
      });
    if (type === "test-model")
      action(async () => {
        await saveModel();
        const result = await api.testModel();
        notify("模型连接成功：" + result.slice(0, 60));
      });
    if (type === "clear-key")
      action(async () => {
        await api.saveKey("");
        await reload();
        render();
        notify("模型密钥已清除");
      });
    if (type === "discover")
      action(async () => {
        await api.discover();
        await reload();
        render();
        notify("已自动连接微信");
      });
    if (type === "refresh-permissions") action(permissionRefresh);
    if (type === "load-windows")
      action(async () => {
        const result = await api.windows();
        windows = result.windows;
        render();
        notify(
          windows.length
            ? "已找到微信窗口"
            : "没有找到微信窗口，请打开并展开电脑微信。",
        );
      });
    if (type === "preview-window")
      action(async () => {
        selectedWindow = Number($("#wechat-window").value);
        if (!selectedWindow) throw new Error("先选择一个微信窗口");
        capture = await api.preview(selectedWindow);
        calibration = structuredClone(workspace.settings.calibration);
        calStep = "title";
        showCalibration();
      });
    if (type === "apply-calibration") {
      const composer = calibration.composer,
        p = calibration.input;
      if (
        p.x < composer.x ||
        p.x > composer.x + composer.w ||
        p.y < composer.y ||
        p.y > composer.y + composer.h
      ) {
        notify("输入位置必须位于输入框内");
        return;
      }
      if (
        ["title", "messages", "composer"].some(
          (k) => calibration[k].w < 0.03 || calibration[k].h < 0.02,
        )
      ) {
        notify("标记范围太小，请重新框选");
        return;
      }
      closeModal();
      notify("区域标记已准备好，请点击“保存连接”。");
    }
    if (type === "save-connection")
      action(async () => {
        const windowId = Number($("#wechat-window").value),
          expectedTitle = $("#expected-title").value.trim();
        if (!windowId || !expectedTitle)
          throw new Error("请选择窗口并填写接待会话名称");
        workspace = await api.saveSettings({
          ...workspace.settings,
          windowId,
          expectedTitle,
          calibration: calibration || workspace.settings.calibration,
        });
        reply = "";
        render();
        notify("连接已保存，回到工作台读取并核对会话。");
      });
    if (type === "summarize-current")
      action(async () => {
        const { activeId, sessions } = await api.summarySessions();
        if (!sessions.length) throw new Error("微信列表暂时没有可总结的会话");
        modal(
          "选择要总结的微信聊天",
          `<label class="e-field">会话<select id="summary-session">${sessions.map((session) => `<option value="${esc(session.id)}" ${session.id === activeId ? "selected" : ""}>${esc(session.name)}</option>`).join("")}</select></label><p>微响会自动切换到该会话并读取可见内容。</p><div class="e-modal-actions"><button class="e-button" data-action="close-modal">取消</button><button class="e-button e-primary" data-action="summarize-selected">提取对话核心</button></div>`,
        );
      });
    if (type === "summarize-selected")
      action(async () => {
        const id = $("#summary-session").value;
        closeModal();
        agent = await api.summarizeCurrent(id);
        render();
        notify("对话核心已保存");
      });
    if (type === "refresh-logs")
      action(async () => {
        await reload();
        render();
      });
    if (type === "data-folder") action(() => api.openDataFolder());
  });
  root.addEventListener("input", (e) => {
    if (e.target.id === "reply-input") reply = e.target.value;
    if (e.target.id === "moment-text") momentText = e.target.value;
  });
  root.addEventListener("change", (e) => {
    if (e.target.id === "profile-category") {
      profileCategory = e.target.value;
      render();
      return;
    }
    if (e.target.id === "wechat-window") {
      selectedWindow = Number(e.target.value);
      capture = null;
      calibration = null;
    }
  });
  root.addEventListener("submit", (e) => {
    if (e.target.id !== "faq-form") return;
    e.preventDefault();
    action(async () => {
      workspace = await api.saveFAQ({
        id: e.target.dataset.id,
        question: $("#faq-question").value,
        answer: $("#faq-answer").value,
        keywords: $("#faq-keywords").value,
        enabled: $("#faq-enabled").checked,
        autoSend: $("#faq-auto").checked,
      });
      closeModal();
      render();
      notify("常见问答已保存");
    });
  });
  root.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeModal();
    if (e.key === "Tab" && !$("#overlay").hidden) {
      const all = [
        ...$("#overlay").querySelectorAll("button,input,textarea,select"),
      ].filter((x) => !x.disabled);
      if (e.shiftKey && document.activeElement === all[0]) {
        e.preventDefault();
        all.at(-1).focus();
      } else if (!e.shiftKey && document.activeElement === all.at(-1)) {
        e.preventDefault();
        all[0].focus();
      }
    }
  });
  if (!api) {
    $("#content").innerHTML =
      '<div class="startup-error"><h2>请从桌面软件打开微响</h2><p>这个页面需要随软件一起运行。</p></div>';
    return;
  }
  api.onState((next) => {
    const changed =
      agent.latest?.fingerprint !== next.latest?.fingerprint ||
      agent.draft?.id !== next.draft?.id ||
      agent.running !== next.running ||
      agent.activityPaused !== next.activityPaused ||
      agent.status !== next.status ||
      agent.analysis !== next.analysis ||
      agent.queueSize !== next.queueSize ||
      agent.tasks?.length !== next.tasks?.length ||
      agent.discovered !== next.discovered ||
      agent.overview?.updatedAt !== next.overview?.updatedAt;
    const newDraft = next.draft?.id && next.draft.id !== agent.draft?.id;
    agent = next;
    if (newDraft) reply = next.draft.text;
    if (!next.draft && !demo) reply = "";
    updateChrome();
    if ((page === "inbox" || page === "logs") && !demo && changed) render();
  });
  reload()
    .then((data) => {
      $("#app-version").textContent = "v" + data.version;
      render();
    })
    .catch((e) => {
      $("#content").innerHTML =
        `<div class="startup-error"><h2>暂时无法打开工作空间</h2><p>${esc(e.message)}</p></div>`;
    });
  icons();
})();
