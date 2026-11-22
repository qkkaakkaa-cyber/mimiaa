const fs = require("node:fs");
function reusableKimiConfig(source) {
  const section =
    source.match(/^\[app\]\s*\n([\s\S]*?)(?=^\[|$(?![\s\S]))/m)?.[1] ||
    source.split(/^\[/m)[0];
  const value = (name) => {
    const match = section.match(
      new RegExp(
        "^\\s*" + name + "\\s*=\\s*(\"(?:[^\"\\\\]|\\\\.)*\"|'[^']*')",
        "m",
      ),
    );
    if (!match) return "";
    return match[1][0] === '"' ? JSON.parse(match[1]) : match[1].slice(1, -1);
  };
  const key = value("moonshot_api_key").trim();
  if (!key || /your.?key|replace|示例|xxxx/i.test(key))
    throw new Error("现有项目中没有可用的 Kimi 密钥");
  const baseUrl = value("moonshot_base_url") || "https://api.moonshot.cn/v1";
  if (
    !["api.moonshot.cn", "api.moonshot.ai"].includes(new URL(baseUrl).hostname)
  )
    throw new Error("复用配置的 Kimi 服务地址需要人工核对");
  return {
    key,
    model: { baseUrl, name: "kimi-k2.6", visionName: "kimi-k2.6" },
  };
}
async function importProvider({ file, store, safeStorage }) {
  if (!fs.existsSync(file)) return null;
  const ref = JSON.parse(fs.readFileSync(file, "utf8"));
  if (ref.provider !== "moonshot" || typeof ref.sourcePath !== "string")
    throw new Error("接口导入来源无效");
  const config = reusableKimiConfig(fs.readFileSync(ref.sourcePath, "utf8"));
  if (
    store.data.settings.model.baseUrl &&
    store.data.settings.model.baseUrl !== config.model.baseUrl
  )
    throw new Error("保留当前模型配置，不覆盖其他服务");
  if (!store.data.settings.model.baseUrl)
    store.settings({ ...store.data.settings, model: config.model });
  let persisted = false;
  if (await safeStorage.isAsyncEncryptionAvailable()) {
    const encrypted = await safeStorage.encryptStringAsync(config.key);
    store.data.encryptedKey = encrypted.toString("base64");
    store.flush();
    fs.unlinkSync(file);
    persisted = true;
  }
  return { key: config.key, persisted };
}
module.exports = { reusableKimiConfig, importProvider };
