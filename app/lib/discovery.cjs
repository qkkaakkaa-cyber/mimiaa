const crypto = require("node:crypto");
const normalize = (s) =>
  String(s || "")
    .normalize("NFKC")
    .trim();
const textOf = (item) => normalize(item?.value || item?.label || item?.title);
const sig = (text) => crypto.createHash("sha256").update(text).digest("hex");
function discoverFromAX(raw) {
  if (!raw || !Array.isArray(raw.items) || !raw.windowId)
    throw new Error("无法读取微信会话列表");
  const items = raw.items,
    find = (id) => items.find((i) => i.id === id),
    list = find("session_list"),
    chat = find("chat_message_list"),
    input = find("chat_input_field"),
    title = find("current_chat_name_label") || find("big_title_line_h_view");
  const relative = (frame) => ({
    x: (frame.x - raw.frame.x) / raw.frame.w,
    y: (frame.y - raw.frame.y) / raw.frame.h,
    w: frame.w / raw.frame.w,
    h: frame.h / raw.frame.h,
  });
  const inList = (frame) =>
    list &&
    frame.w > 10 &&
    frame.h > 10 &&
    frame.x >= list.frame.x - 3 &&
    frame.y + frame.h > list.frame.y &&
    frame.y < list.frame.y + list.frame.h;
  const sessions = items
    .filter((i) => i.id.startsWith("session_item_") && inList(i.frame))
    .map((item) => {
      const name = normalize(item.id.slice("session_item_".length)),
        label = textOf(item);
      const lines = label.split(/\n+/).map(normalize).filter(Boolean);
      const preview = lines
        .filter(
          (l) =>
            l !== name &&
            l !== "已置顶" &&
            !/^(?:\d{1,2}:\d{2}|昨天|星期.|周.|\d{4}\/\d{2}\/\d{2}|\d{1,2}月\d{1,2}日)$/.test(
              l,
            ),
        )
        .join("\n");
      return {
        id: item.id,
        name,
        preview,
        signature: sig(preview),
        unread: /\d+条(?:未读|新消息)|未读消息|有人@我/.test(label),
        time: lines.at(-1) || "",
        point: {
          x: relative(item.frame).x + relative(item.frame).w / 2,
          y: relative(item.frame).y + relative(item.frame).h / 2,
        },
      };
    });
  const counts = new Map();
  for (const row of sessions)
    counts.set(row.name, (counts.get(row.name) || 0) + 1);
  const unique = sessions.filter(
    (s) =>
      counts.get(s.name) === 1 &&
      ![
        "公众号",
        "服务号",
        "订阅号消息",
        "服务通知",
        "微信团队",
        "文件传输助手",
        "微信支付",
      ].includes(s.name),
  );
  let active = null;
  if (chat && input && title) {
    const rawName = textOf(title),
      name = rawName.replace(/\s*[（(]\d+[)）]\s*$/, "").trim(),
      session = unique.find((s) => s.name === name);
    const voip = items.find((i) => i.id === "voip_button"),
      callText = textOf(voip);
    // A member count or a group-call control is positive group evidence.
    // A one-to-one voice-call control identifies a private conversation.
    const kind =
      /[（(]\d+[)）]\s*$/.test(rawName) ||
      /群.*(?:通话|语音)|group/i.test(callText)
        ? "group"
        : /^语音通话$|^voice call$/i.test(callText)
          ? "private"
          : "unknown";
    const composer = relative(input.frame),
      messages = relative(chat.frame),
      titleRegion = relative(title.frame);
    if (composer.y > messages.y)
      messages.h = Math.min(messages.h, composer.y - messages.y - 0.006);
    // Short names such as "mi" have very narrow AX text bounds. Give OCR a
    // padded header region while keeping identity verification exact.
    titleRegion.x = Math.max(messages.x, titleRegion.x - 0.008);
    titleRegion.y = Math.max(0, titleRegion.y - 0.008);
    titleRegion.w = Math.min(
      1 - titleRegion.x,
      Math.max(0.12, titleRegion.w + 0.016),
    );
    titleRegion.h = Math.min(
      1 - titleRegion.y,
      Math.max(0.04, titleRegion.h + 0.016),
    );
    const valid = (r) =>
      r.x >= 0 &&
      r.y >= 0 &&
      r.w >= 0.03 &&
      r.h >= 0.02 &&
      r.x + r.w <= 1.001 &&
      r.y + r.h <= 1.001;
    if ([composer, messages, titleRegion].every(valid))
      active = {
        sessionId: session?.id || "",
        expectedTitle: name,
        kind,
        windowId: raw.windowId,
        calibration: {
          title: titleRegion,
          messages,
          composer,
          input: {
            x: composer.x + Math.min(composer.w * 0.3, 0.12),
            y: composer.y + Math.min(composer.h * 0.35, 0.04),
          },
        },
      };
  }
  const messageLines = active
    ? items
        .filter((i) => i.id === "chat_bubble_item_view")
        .map((item) => ({
          text: textOf(item),
          box: relative(item.frame),
          confidence: 1,
          source: "accessibility-message",
        }))
        .filter(
          (line) =>
            line.text &&
            line.box.w > 0 &&
            line.box.h > 0 &&
            line.box.y >= active.calibration.messages.y - 0.01 &&
            line.box.y + line.box.h <=
              active.calibration.messages.y +
                active.calibration.messages.h +
                0.02 &&
            !/WeChat转账|微信转账|微信红包|^图片$|^视频(?:号|\s)|^\[文件\]/i.test(
              line.text,
            ),
        )
    : [];
  for (const line of messageLines) {
    const voice = line.text.match(
      /^语音\s*\d+\s*["″”']?\s*秒(?:未播放)?([\s\S]*)$/,
    );
    if (voice) {
      line.mediaType = "voice";
      line.transcribed = !!voice[1].trim();
      line.text = voice[1].trim() || "【语音消息，尚未转文字】";
    }
  }
  return {
    messageLines,
    composerText: input ? String(input.value || "") : undefined,
    windowId: raw.windowId,
    pid: raw.pid,
    frame: raw.frame,
    sessions: unique,
    active,
  };
}
function groupAllowed(context, snapshot, settings) {
  const scope = settings.reception;
  if (context.kind === "private") return scope.privateChats;
  if (context.kind === "unknown") return false;
  if (!scope.groupChats) return false;
  if (scope.groupPolicy === "all") return true;
  const message = snapshot.last?.text || "";
  if (
    scope.groupPolicy === "questions" &&
    /[?？]|请问|咨询|怎么|如何|哪里|什么时候|能不能|可以吗/.test(message)
  )
    return true;
  return !!scope.mentionName && message.includes("@" + scope.mentionName);
}
module.exports = { discoverFromAX, groupAllowed };
