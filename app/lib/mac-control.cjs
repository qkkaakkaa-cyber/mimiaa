const { clean, within, verifyTitle, parseSnapshot } = require("./domain.cjs");
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const ordered = (capture, region) =>
  capture.lines
    .filter((line) => within(line.box, region))
    .sort((a, b) => a.box.y - b.box.y || a.box.x - b.box.x)
    .map((line) => clean(line.text));
const sameWindow = (a, b) =>
  a.pid === b.pid &&
  ["x", "y", "w", "h"].every((k) => a.frame[k] === b.frame[k]);

class MacControlBridge {
  constructor({ helper, control, preferences, idleTime, sleep = wait }) {
    Object.assign(this, { helper, control, preferences, idleTime, sleep });
    this.epoch = 0;
    this.backgroundCapable = !!(control.setComposer && control.pressSend);
  }
  cancelSends() {
    this.epoch++;
  }
  async request(command, payload = {}) {
    if (command === "discover")
      return require("./discovery.cjs").discoverFromAX(
        JSON.parse(this.control.inspect()),
      );
    if (command === "select-session") return this.selectSession(payload);
    if (command === "permissions") {
      const capture = this.control.screenTrusted
        ? { screen: this.control.screenTrusted() }
        : await this.helper.request("permissions");
      return {
        screen: capture.screen,
        accessibility: this.control.isTrusted(),
        permissionOwner: "微响",
        controlReady: true,
      };
    }
    if (command === "request-accessibility") {
      return { granted: this.preferences.isTrustedAccessibilityClient(true) };
    }
    if (command === "request-screen" && this.control.requestScreen)
      return { granted: this.control.requestScreen() };
    if (command === "capture" && this.control.capture)
      return this.capture(payload.windowId);
    if (command === "send") return this.send(payload);
    if (
      !["request-screen", "capture", "windows", "extract-document"].includes(
        command,
      )
    )
      throw new Error("不支持的本机操作");
    return this.helper.request(command, payload);
  }
  async capture(windowId) {
    if (!Number.isSafeInteger(windowId) || windowId <= 0)
      throw new Error("微信窗口编号无效");
    const inspect = () =>
      this.control.inspect
        ? require("./discovery.cjs").discoverFromAX(
            JSON.parse(this.control.inspect()),
          )
        : null;
    const before = inspect();
    const capture = JSON.parse(await this.control.capture({ windowId }));
    const ocr = await this.helper.request("ocr-image", {
      image: capture.image,
    });
    const after = inspect();
    let lines = ocr.lines;
    if (
      before?.active &&
      after?.active &&
      before.windowId === windowId &&
      after.windowId === windowId
    ) {
      if (
        before.active.sessionId !== after.active.sessionId ||
        before.active.expectedTitle !== after.active.expectedTitle ||
        !sameWindow(before, after)
      )
        throw new Error("读取期间聊天对象或窗口发生变化");
      if (
        JSON.stringify(before.messageLines?.map((l) => l.text)) !==
        JSON.stringify(after.messageLines?.map((l) => l.text))
      ) {
        const error = new Error("读取期间客户消息发生变化");
        error.canRetry = true;
        throw error;
      }
      if (after.messageLines?.length) {
        const accessible = after.messageLines.map((line) => ({
          ...line,
          outgoing: ocr.lines.some(
            (o) => o.outgoing && within(o.box, line.box),
          ),
        }));
        lines = [
          ...lines.filter(
            (line) => !within(line.box, after.active.calibration.messages),
          ),
          ...accessible,
        ];
      }
      if (typeof after.composerText === "string") {
        lines = lines.filter(
          (line) => !within(line.box, after.active.calibration.composer),
        );
        if (after.composerText.trim())
          lines.push({
            text: after.composerText,
            box: after.active.calibration.composer,
            confidence: 1,
            source: "accessibility-composer",
          });
      }
      lines = [
        ...lines,
        {
          text: after.active.expectedTitle,
          box: after.active.calibration.title,
          confidence: 1,
          source: "accessibility-title",
        },
      ];
    }
    return {
      ...capture,
      lines,
      ...(after?.active ? { calibration: after.active.calibration } : {}),
    };
  }
  async selectSession({ id, signature, manual = false }) {
    const ticket = this.epoch;
    const discover = () =>
      require("./discovery.cjs").discoverFromAX(
        JSON.parse(this.control.inspect()),
      );
    const before = discover(),
      row = before.sessions.find((s) => s.id === id);
    if (!row || row.signature !== signature)
      throw new Error("会话列表已更新，稍后重新识别");
    if (before.active?.sessionId === id) return before;
    if (!manual && this.idleTime() < 5)
      throw new Error("已发现消息，等待空闲时切换会话");
    if (!manual && this.control.isWeChatActive?.())
      throw new Error("你正在使用微信，AI 已自动暂停");
    const previousPID = this.control.frontmostPID?.();
    const target = { pid: before.pid, frame: before.frame };
    this.navigating = true;
    try {
      this.control.focus(target);
      await this.sleep(350);
      if (ticket !== this.epoch) throw new Error("接待已暂停");
      const current = discover(),
        again = current.sessions.find((s) => s.id === id);
      if (
        !again ||
        again.signature !== signature ||
        !sameWindow(current, target)
      )
        throw new Error("会话列表或窗口位置已变化");
      this.control.clickInput({ ...target, input: again.point });
      await this.sleep(manual ? 420 : 5200);
      if (!manual && this.idleTime() < 5)
        throw new Error("检测到人工操作，稍后继续接待");
      if (ticket !== this.epoch) throw new Error("接待已暂停");
      const after = discover();
      if (
        after.active?.sessionId !== id ||
        after.active.expectedTitle !== row.name
      )
        throw new Error("无法核对切换后的聊天对象");
      return after;
    } finally {
      // Only return focus if the user has not intervened. A real click in
      // WeChat leaves it active, and normal activity polling then pauses AI.
      try {
        if (
          previousPID &&
          previousPID !== target.pid &&
          (manual || this.idleTime() >= 5)
        ) {
          this.control.restoreFocus?.({ pid: previousPID });
          await this.sleep(250);
        }
      } finally {
        this.navigating = false;
      }
    }
  }

  async send(payload) {
    let commitStarted = false,
      inputPrepared = false;
    try {
      const {
        windowId,
        expectedTitle,
        calibration,
        text,
        expectedOCR,
        width,
        height,
      } = payload;
      if (!this.control.isTrusted())
        throw new Error("微响尚未获得辅助功能权限，请在系统设置中开启");
      if (
        !Number.isSafeInteger(windowId) ||
        !expectedTitle ||
        typeof text !== "string" ||
        !text ||
        text.length > 1500 ||
        /[\u0000-\u001f\u007f]/u.test(text) ||
        !Array.isArray(expectedOCR) ||
        !expectedOCR.length
      )
        throw new Error("发送参数不完整");
      if (!within({ ...calibration.input, w: 0, h: 0 }, calibration.composer))
        throw new Error("输入位置必须位于输入框内");
      const ticket = this.epoch;
      const checkCancelled = () => {
        if (ticket !== this.epoch)
          throw new Error("操作已暂停，本次发送已取消");
      };
      if (payload.automatic && !this.backgroundCapable && this.idleTime() < 5)
        throw new Error("检测到人工操作，自动发送已取消");
      const signature = expectedOCR.map(clean);
      const capture = async ({ empty = false, typed = false } = {}) => {
        const current = await (this.control.capture
          ? this.capture(windowId)
          : this.helper.request("capture", { windowId }));
        checkCancelled();
        if (!verifyTitle(current.lines, expectedTitle, calibration))
          throw new Error("聊天对象变化，已取消发送");
        if (
          Math.abs(current.width - width) >= 3 ||
          Math.abs(current.height - height) >= 3
        )
          throw new Error("微信窗口尺寸变化，请重新标记区域");
        if (
          payload.expectedFingerprint
            ? parseSnapshot(current, { calibration, expectedTitle })
                .fingerprint !== payload.expectedFingerprint
            : JSON.stringify(ordered(current, calibration.messages)) !==
              JSON.stringify(signature)
        )
          throw new Error("客户消息发生变化，已取消发送");
        const input = ordered(current, calibration.composer).filter(
          (t) =>
            t && !["发送", "发送s", "send", "输入消息", "输入文字"].includes(t),
        );
        if (empty && input.length && input.join("") !== clean(text))
          throw new Error("微信输入框里已有内容，请先自行处理草稿");
        if (typed && input.join("") !== clean(text))
          throw new Error("未能确认输入框中的回复，请到微信检查草稿");
        if (
          !current.window ||
          !Number.isSafeInteger(current.window.pid) ||
          !current.window.frame
        )
          throw new Error("窗口信息不完整，请更新本机组件");
        return current;
      };
      let current = await capture({ empty: true });
      const target = { pid: current.window.pid, frame: current.window.frame };
      if (this.backgroundCapable) {
        if (payload.automatic && this.control.isWeChatActive?.())
          throw new Error("你正在操作微信，本次保留草稿");
        checkCancelled();
        const historyOf = (raw) =>
          raw.items
            .filter((i) => i.id === "chat_bubble_item_view")
            .map((i) => i.value || i.label || i.title || "");
        const rawBefore = this.control.inspect
          ? JSON.parse(this.control.inspect())
          : null;
        const alreadyPrepared =
          ordered(
            current,
            current.calibration?.composer || calibration.composer,
          )
            .filter(Boolean)
            .join("") === clean(text);
        inputPrepared = true;
        if (!alreadyPrepared)
          this.control.setComposer({ ...target, expectedTitle, text });
        await this.sleep(200);
        checkCancelled();
        let expectedMessages;
        if (rawBefore) {
          const rawAfter = JSON.parse(this.control.inspect());
          if (
            JSON.stringify(historyOf(rawBefore)) !==
            JSON.stringify(historyOf(rawAfter))
          )
            throw new Error("输入期间客户消息发生变化，保留草稿");
          const composer = rawAfter.items.find(
            (i) => i.id === "chat_input_field",
          );
          if (composer?.value !== text)
            throw new Error("微信输入内容未读回确认，保留草稿");
          expectedMessages = JSON.stringify(historyOf(rawAfter));
        } else {
          current = await capture({ typed: true });
          if (!sameWindow(current.window, target))
            throw new Error("微信窗口位置变化，保留草稿");
        }
        checkCancelled();
        if (payload.automatic && this.control.isWeChatActive?.())
          throw new Error("你正在使用微信，自动暂停");
        commitStarted = true;
        this.control.pressSend({
          ...target,
          expectedTitle,
          text,
          ...(expectedMessages ? { expectedMessages } : {}),
        });
        await this.sleep(500);
        return { attempted: true };
      }
      this.control.focus(target);
      await this.sleep(400);
      checkCancelled();
      current = await capture({ empty: true });
      if (!sameWindow(current.window, target))
        throw new Error("微信窗口位置已变化，请重新读取");
      this.control.clickInput({ ...target, input: calibration.input });
      await this.sleep(150);
      checkCancelled();
      inputPrepared = true;
      let chunk = "";
      for (const character of text) {
        if (chunk.length + character.length > 16) {
          checkCancelled();
          this.control.typeChunk({ ...target, text: chunk });
          await this.sleep(25);
          chunk = "";
        }
        chunk += character;
      }
      if (chunk) {
        checkCancelled();
        this.control.typeChunk({ ...target, text: chunk });
      }
      await this.sleep(250);
      checkCancelled();
      current = await capture({ typed: true });
      if (!sameWindow(current.window, target))
        throw new Error("微信窗口位置已变化，请到微信检查草稿");
      checkCancelled();
      commitStarted = true;
      this.control.commit(target);
      await this.sleep(700);
      return { attempted: true };
    } catch (error) {
      error.sendAttempted = commitStarted;
      error.inputPrepared = inputPrepared;
      error.canRetry =
        !commitStarted &&
        (!inputPrepared || /暂停|操作微信|使用微信/.test(error.message)) &&
        /客户消息.*变化|聊天.*变化|操作微信|人工操作|窗口.*变化|期间|暂停/.test(
          error.message,
        );
      throw error;
    }
  }
}
module.exports = { MacControlBridge };
