const test = require("node:test"),
  assert = require("node:assert/strict");
const {
  Intelligence,
  validateDecision,
  mergeHistory,
  sourcesFor,
} = require("../app/lib/intelligence.cjs");
const { DEFAULT_SETTINGS } = require("../app/lib/domain.cjs");
const { reusableKimiConfig } = require("../app/lib/provider-import.cjs");
const settings = structuredClone(DEFAULT_SETTINGS),
  sources = [{ id: "business", name: "业务介绍", text: "服务范围为杭州" }];
test("虚构的引用和缺少依据的回答不能自动发送", () => {
  for (const sourceIds of [[], ["invented"]]) {
    const result = validateDecision(
      { action: "reply", reply: "好的", sourceIds },
      sources,
      settings,
      "在哪里",
    );
    assert.equal(result.canAuto, false);
    assert.equal(result.action, "handoff");
  }
});
test("自然追问可接待，涉及退款与价格的内容等待人工", () => {
  assert.equal(
    validateDecision(
      { action: "ask", reply: "您希望什么时候搬家？" },
      sources,
      settings,
      "找房",
    ).canAuto,
    true,
  );
  assert.equal(
    validateDecision(
      { action: "reply", reply: "价格是五千元", sourceIds: ["business"] },
      sources,
      settings,
      "报价",
    ).canAuto,
    false,
  );
});
test("重叠窗口消息合并后保留多轮上下文", () => {
  const a = { role: "in", text: "找两居室" },
    b = { role: "out", text: "什么预算？" },
    c = { role: "in", text: "五千" };
  assert.deepEqual(mergeHistory([a, b], [b, c]), [a, b, c]);
});
test("检索业务文档且不把密钥提供给模型", async () => {
  let payload;
  const data = {
    settings: {
      ...settings,
      business: "服务范围杭州",
      model: { baseUrl: "https://api.moonshot.cn/v1", name: "kimi-k2.6" },
    },
    faqs: [],
    documents: [
      {
        id: "doc",
        name: "营业时间",
        text: "每天九点到十八点营业",
        enabled: true,
      },
    ],
    encryptedKey: "must-not-leak",
  };
  const ai = new Intelligence({
    data,
    getKey: async () => "test-secret",
    fetchImpl: async (url, opts) => {
      payload = JSON.parse(opts.body);
      assert.equal(opts.headers.Authorization, "Bearer test-secret");
      return {
        ok: true,
        json: async () => ({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  action: "reply",
                  reply: "我们每天九点到十八点营业。",
                  sourceIds: ["doc#0"],
                  reason: "营业时间资料",
                }),
              },
            },
          ],
        }),
      };
    },
  });
  const result = await ai.decide([{ role: "in", text: "几点营业" }]);
  assert.equal(result.canAuto, true);
  assert.equal(JSON.stringify(payload).includes("must-not-leak"), false);
  assert.equal(payload.thinking.type, "disabled");
  assert.deepEqual(payload.response_format, { type: "json_object" });
});
test("已有配置解析只接受官方服务且排除其他分节", () => {
  const cfg = reusableKimiConfig(
    '[app]\nmoonshot_api_key = "test-key-123"\nmoonshot_base_url = ""\n[other]\nmoonshot_api_key = "wrong"',
  );
  assert.equal(cfg.key, "test-key-123");
  assert.equal(cfg.model.name, "kimi-k2.6");
  assert.throws(() =>
    reusableKimiConfig(
      '[app]\nmoonshot_api_key = "test-key"\nmoonshot_base_url = "https://evil.example/v1"',
    ),
  );
});
