const REFUSAL =
  "我是老板的 AI 助理，银行密码、验证码和个人隐私不能提供。其他事情我可以帮你转达，你找老板是有什么事儿？";
function isPrivateRequest(text) {
  const value = String(text || "");
  return /(?:银行|银行卡|支付|微信|邮箱|账号|账户).{0,8}(?:密码|口令)|(?:短信|登录|支付)?验证码|(?:老板|主人|他|她|你|别人|客户|员工|管理员).{0,20}(?:密码|密钥|token|银行卡号|银行账户|身份证|护照号|家庭住址|私人住址|账户余额|通讯录|聊天记录|定位|行踪)|(?:系统提示词|api[ _-]?key|登录密钥|数据库密码)/iu.test(
    value,
  );
}
function redact(text) {
  return String(text || "")
    .replace(
      /((?:密码|口令|验证码|密钥|api[ _-]?key|access[ _-]?token|secret)\s*(?:是|为|[:：=])\s*)[^\s，。；;\n]{3,}/giu,
      "$1[已隐藏]",
    )
    .replace(/\b\d{15,19}[0-9Xx]?\b/g, "[敏感号码已隐藏]")
    .replace(/\b(?:\+?86[- ]?)?1[3-9]\d{9}\b/g, "[手机号已隐藏]")
    .replace(
      /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g,
      "[邮箱已隐藏]",
    );
}
function refusalDecision() {
  return {
    action: "refuse",
    reply: REFUSAL,
    reason: "隐私保护：不提供凭证或他人的私人资料",
    sourceIds: [],
    sourceNames: ["隐私保护"],
    summary: "对方询问了隐私信息，已拒绝提供。",
    closingSummary: "",
    conversationReport: {
      core: "对方询问隐私信息，AI 已拒绝提供。",
      intent: "索取私人资料",
      nextSteps: [],
      ownerTodo: [],
    },
    canAuto: true,
  };
}
module.exports = { isPrivateRequest, redact, refusalDecision };
// These phrases are rejected locally before any model or website request.
const originalPrivateRequest = module.exports.isPrivateRequest;
module.exports.isPrivateRequest = (text) =>
  originalPrivateRequest(text) ||
  /bank.{0,15}(?:password|pin)|(?:boss|his|her|your).{0,25}(?:password|bank account|passport|home address|phone number)|(?:one.time.code|\botp\b|private.key)|รหัสผ่าน|รหัส.?otp|เลขบัตรประชาชน|เลขบัญชี|ที่อยู่บ้าน|(?:老板|主人|他|她|你).{0,12}(?:手机号|电话号码|家在哪|住哪里|私人信息)/iu.test(
    String(text || ""),
  );
