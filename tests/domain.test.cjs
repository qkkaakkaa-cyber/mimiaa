const test = require("node:test");
const assert = require("node:assert/strict");
const {
  DEFAULT_SETTINGS,
  validateSettings,
  verifyTitle,
  parseSnapshot,
  planReply,
  matchFAQ,
  validateEndpoint,
  validateFAQ,
} = require("../app/lib/domain.cjs");
const settings = () =>
  validateSettings({
    ...DEFAULT_SETTINGS,
    expectedTitle: "客户甲",
    windowId: 42,
  });
const line = (text, x, y, outgoing = false) => ({
  text,
  box: { x, y, w: 0.15, h: 0.025 },
  outgoing,
  confidence: 0.98,
});
const capture = (extra = []) => ({
  width: 1000,
  height: 800,
  lines: [line("客户甲", 0.4, 0.04), line("你好", 0.35, 0.2), ...extra],
});
test("标题必须完全匹配，避免同名前缀选错客户", () => {
  const s = settings();
  assert.equal(
    verifyTitle([line("客户甲乙", 0.4, 0.04)], "客户甲", s.calibration),
    false,
  );
  assert.equal(
    verifyTitle([line("客户甲（2）", 0.4, 0.04)], "客户甲", s.calibration),
    true,
  );
  assert.equal(
    verifyTitle([line("客户甲", 0.4, 0.4)], "客户甲", s.calibration),
    false,
  );
});
test("标题保留大小写、空格和标点身份差异", () => {
  const s = settings();
  for (const [actual, expected] of [
    ["A-B", "AB"],
    ["Alpha", "alpha"],
    ["A B", "AB"],
  ])
    assert.equal(
      verifyTitle([line(actual, 0.4, 0.04)], expected, s.calibration),
      false,
    );
});
test("低置信度标题与消息不能触发自动回复", () => {
  const s = settings(),
    c = capture();
  c.lines[0].confidence = 0.6;
  assert.equal(parseSnapshot(c, s).titleVerified, false);
  c.lines[0].confidence = 0.99;
  c.lines[1].confidence = 0.6;
  assert.equal(parseSnapshot(c, s).last.role, "unknown");
});
test("消息区域排除联系人列表和标题", () => {
  const parsed = parseSnapshot(
    capture([line("其他客户", 0.05, 0.4), line("今天", 0.6, 0.35)]),
    settings(),
  );
  assert.deepEqual(parsed.messages, [{ role: "in", text: "你好" }]);
  assert.equal(parsed.titleVerified, true);
});
test("长的绿色回复不会被误判为客户消息", () => {
  const shot = capture([line("这是已经发出的长回复", 0.35, 0.35, true)]);
  assert.equal(parseSnapshot(shot, settings()).last.role, "out");
});
test("居中的不明内容不触发自动回复", () => {
  const s = settings();
  s.mode = "auto";
  const parsed = parseSnapshot(capture([line("你好", 0.65, 0.4)]), s);
  assert.equal(parsed.last.role, "unknown");
  assert.equal(
    planReply(parsed, s, [
      { enabled: true, question: "你好", answer: "您好", autoSend: true },
    ]).kind,
    "idle",
  );
});
test("换行合并，同时保留新气泡", () => {
  const parsed = parseSnapshot(
    capture([
      line("第一行", 0.35, 0.4),
      line("第二行", 0.35, 0.43),
      line("下个气泡", 0.35, 0.55),
    ]),
    settings(),
  );
  assert.equal(parsed.messages[1].text, "第一行\n第二行");
  assert.equal(parsed.messages.length, 3);
});
test("消息指纹不依赖微小坐标变化", () => {
  const a = capture(),
    b = capture();
  b.lines[1].box.y += 0.001;
  assert.equal(
    parseSnapshot(a, settings()).fingerprint,
    parseSnapshot(b, settings()).fingerprint,
  );
  b.lines[1].text = "新问题";
  assert.notEqual(
    parseSnapshot(a, settings()).fingerprint,
    parseSnapshot(b, settings()).fingerprint,
  );
});
test("重复问答或关键词歧义必须交给人工", () => {
  const list = [
    { enabled: true, question: "营业时间", answer: "A", keywords: ["营业"] },
    { enabled: true, question: "营业时间", answer: "B", keywords: ["营业"] },
  ];
  assert.equal(matchFAQ("营业时间", list), null);
  assert.equal(matchFAQ("你们几点营业？", list), null);
});
test("需要模式与逐条授权同时满足才自动发送", () => {
  const s = settings(),
    snapshot = parseSnapshot(capture(), s),
    faqs = [
      { enabled: true, question: "你好", answer: "您好", autoSend: true },
    ];
  assert.equal(planReply(snapshot, s, faqs).kind, "draft");
  s.mode = "auto";
  assert.equal(planReply(snapshot, s, faqs).kind, "auto");
  faqs[0].autoSend = false;
  assert.equal(planReply(snapshot, s, faqs).kind, "draft");
});
test("价格、退款与合同不能因为匹配关键词就自动发送", () => {
  const s = settings();
  s.mode = "auto";
  const parsed = parseSnapshot(
    capture([line("你好，退款怎么办", 0.35, 0.4)]),
    s,
  );
  assert.equal(
    planReply(parsed, s, [
      {
        enabled: true,
        question: "问候",
        keywords: ["你好"],
        answer: "收到",
        autoSend: true,
      },
    ]).kind,
    "draft",
  );
});
test("禁用的问答不能生成答案", () => {
  assert.equal(
    matchFAQ("你好", [{ question: "你好", answer: "您好", enabled: false }]),
    null,
  );
});
test("未核实会话标题时阻止所有自动计划", () => {
  const s = settings();
  s.expectedTitle = "其他人";
  assert.equal(planReply(parseSnapshot(capture(), s), s, []).kind, "blocked");
});
test("拒绝远端 HTTP、密码和查询参数，仅允许本机 HTTP", () => {
  for (const url of [
    "http://example.com/v1",
    "https://user:password@example.com/v1",
    "https://example.com/v1?key=secret",
    "file:///etc/passwd",
  ])
    assert.throws(() => validateEndpoint(url));
  assert.equal(
    validateEndpoint("http://127.0.0.1:11434/v1/"),
    "http://127.0.0.1:11434/v1",
  );
  assert.equal(
    validateEndpoint("https://example.com/v1"),
    "https://example.com/v1",
  );
});
test("区域必须在窗口里，输入点必须在输入框里", () => {
  const a = settings();
  a.calibration.messages.w = 2;
  assert.throws(() => validateSettings(a));
  const b = settings();
  b.calibration.input = { x: 0.1, y: 0.1 };
  assert.throws(() => validateSettings(b));
});
test("问答保存默认不授权自动发送", () => {
  assert.equal(
    validateFAQ({ question: "问题", answer: "答案" }).autoSend,
    false,
  );
  assert.throws(() => validateFAQ({ question: "", answer: "答案" }));
});
