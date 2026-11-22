const test = require("node:test");
const assert = require("node:assert/strict");
const {
  profileFromAX,
  watchedMoments,
} = require("../app/lib/wechat-tools.cjs");

test("联系人画像按可见签名分类，不把联系方式当成业务线索", () => {
  const items = [
    { id: "head_view_", frame: { x: 30, y: 10, w: 50, h: 50 } },
    { id: "display_name_text", value: "测试客户" },
    { id: "basic_line.key_text", value: "WeChat ID: test_account 地区：曼谷" },
    { value: "更多信息 个性签名" },
    { id: "value_reader_", value: "招聘中文翻译，电话 13600001234" },
    { value: "来源" },
    { id: "value_reader_", value: "通过搜索添加" },
  ];
  const result = profileFromAX({ items });
  assert.deepEqual(result.categories, ["招聘用工", "企业服务"]);
  assert.match(result.signature, /\[手机号已隐藏\]/);
  assert.doesNotMatch(JSON.stringify(result), /test_account|通过搜索/);
});

test("朋友圈只归档名单中可见动态，跳过评论和相似名称", () => {
  const result = watchedMoments(
    {
      items: [
        { id: "sns_list", depth: 4 },
        { value: "小林 木工招人 3分钟前", depth: 5, role: "AXStaticText" },
        { value: "小林子 找工作 3分钟前", depth: 5, role: "AXStaticText" },
        { value: "小林 一条评论", depth: 6, role: "AXStaticText" },
        { value: "小林 窗口其他内容", depth: 4, role: "AXStaticText" },
      ],
    },
    ["小林"],
  );
  assert.deepEqual(
    result.map(({ author, excerpt }) => [author, excerpt]),
    [["小林", "木工招人"]],
  );
});

test("私聊画像只记录对方明确的职业自述", () => {
  const { historyEvidence } = require("../app/lib/wechat-tools.cjs");
  const result = historyEvidence([
    { role: "out", text: "我在做物流" },
    { role: "in", text: "请问物流什么价格？" },
    { role: "in", text: "我以前做培训。" },
    { role: "in", text: "我是做外贸物流的。" },
  ]);
  assert.deepEqual(result, [
    { text: "我是做外贸物流的", categories: ["商贸物流"] },
  ]);
});
