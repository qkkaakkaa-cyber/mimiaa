const { spawn } = require("node:child_process");
class NativeBridge {
  constructor(binary) {
    this.binary = binary;
    this.sending = new Set();
  }
  cancelSends() {
    for (const child of this.sending) child.kill("SIGTERM");
    this.sending.clear();
  }
  request(command, payload = {}) {
    return new Promise((resolve, reject) => {
      const process = spawn(this.binary, [command], {
        stdio: ["pipe", "pipe", "pipe"],
      });
      let out = "",
        err = "",
        settled = false;
      if (command === "send") this.sending.add(process);
      const fail = (message) => {
        this.sending.delete(process);
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          reject(new Error(message));
        }
      };
      const timer = setTimeout(() => {
        process.kill();
        fail("微信窗口操作超时，请检查窗口和系统权限");
      }, 25000);
      process.stdout.on("data", (chunk) => {
        out += chunk;
        if (out.length > 28 * 1024 * 1024) {
          process.kill();
          fail("窗口图像过大，请缩小微信窗口后重试");
        }
      });
      process.stderr.on("data", (chunk) => {
        err += chunk;
      });
      process.on("error", () =>
        fail("本机微信组件不可用，请使用完整的 macOS 安装包"),
      );
      process.on("close", () => {
        this.sending.delete(process);
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        try {
          const result = JSON.parse(out);
          if (!result.ok) reject(new Error(result.error || "操作失败"));
          else resolve(result.data);
        } catch {
          reject(new Error("本机组件返回异常，请重新打开软件"));
        }
      });
      process.stdin.on("error", () => {});
      process.stdin.end(JSON.stringify(payload));
    });
  }
}
module.exports = { NativeBridge };
