const { clean } = require("./domain.cjs");
const STYLES = {
  warm: "温和自然，先听对方说，关心但不说教，少用客服套话",
  witty: "轻松幽默，可以适度开玩笑，不拿对方的困难或隐私开玩笑",
  direct: "简洁直接，先给明确回应，句子短，少客套",
  steady: "沉稳耐心，条理清楚，语气可靠，不浮夸",
};
function styleInstruction(settings, profile) {
  const p = settings.personality || {};
  return [
    STYLES[p.preset] || STYLES.warm,
    p.custom || "",
    p.learnFromHistory && profile?.summary
      ? "参考老板已学习的表达习惯：" + profile.summary
      : "",
  ]
    .filter(Boolean)
    .join("；");
}
function learnStyle(messages, excludedHashes = []) {
  const crypto = require("node:crypto");
  const excluded = new Set(excludedHashes);
  const seen = new Set();
  const samples = messages
    .filter(
      (m) => m.role === "out" && typeof m.text === "string" && m.text.trim(),
    )
    .map((m) => m.text.trim())
    .filter((text) => {
      const hash = crypto
        .createHash("sha256")
        .update(clean(text))
        .digest("hex");
      if (
        excluded.has(hash) ||
        seen.has(hash) ||
        text.length > 600 ||
        /密码|验证码|转账|身份证|护照|银行卡|病历|医院/.test(text)
      )
        return false;
      seen.add(hash);
      return true;
    })
    .slice(-500);
  if (samples.length < 3)
    throw new Error(
      "至少需要 3 条你自己发过的文字。请在微信打开有历史消息的聊天后再学习。",
    );
  const avg = Math.round(
    samples.reduce((n, s) => n + [...s].length, 0) / samples.length,
  );
  const words = [
    "哈哈",
    "好的",
    "行",
    "嗯",
    "吧",
    "啦",
    "呀",
    "谢谢",
    "麻烦",
    "您",
  ]
    .map((word) => ({
      word,
      count: samples.filter((t) => t.includes(word)).length,
    }))
    .filter((x) => x.count >= 2)
    .sort((a, b) => b.count - a.count)
    .slice(0, 4);
  const question = Math.round(
    (samples.filter((t) => /[?？]|吗$|呢$/.test(t)).length / samples.length) *
      100,
  );
  return {
    sampleCount: samples.length,
    summary: `常用${avg <= 25 ? "短句" : avg <= 60 ? "中等长度句子" : "较完整的长句"}，平均每条约 ${avg} 字。${words.length ? "常用表达：" + words.map((x) => x.word).join("、") + "。" : ""}${question >= 20 ? "经常顺着话题提问。" : "提问适量，优先把意思说清楚。"}`,
    updatedAt: new Date().toISOString(),
    rawTextUploaded: false,
  };
}
module.exports = { styleInstruction, learnStyle, STYLES };
