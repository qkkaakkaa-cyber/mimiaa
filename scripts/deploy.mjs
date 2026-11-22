import { execFileSync } from "node:child_process";
import { existsSync, renameSync, accessSync, constants } from "node:fs";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const source = root + "/dist/回响.app";
const target = "/Applications/回响.app";
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const staging = `/Applications/.回响-installing-${stamp}.app`;
const backup = `/Applications/.回响-previous-${stamp}.app`;
if (!existsSync(source)) throw new Error("请先运行 npm run build 生成应用包");
accessSync("/Applications", constants.W_OK);
execFileSync("codesign", ["--verify", "--deep", "--strict", source]);
if (existsSync(target)) {
  const identifier = execFileSync("/usr/libexec/PlistBuddy", [
    "-c", "Print :CFBundleIdentifier", target + "/Contents/Info.plist",
  ], { encoding: "utf8" }).trim();
  if (identifier !== "com.huixiang.desktop") throw new Error("已有同名的其他应用，已停止安装");
}
execFileSync("/usr/bin/ditto", [source, staging]);
execFileSync("codesign", ["--verify", "--deep", "--strict", staging]);
if (existsSync(target)) renameSync(target, backup);
try { renameSync(staging, target); }
catch (error) { if (existsSync(backup)) renameSync(backup, target); throw error; }
console.log("已安装到：" + target);
if (existsSync(backup)) console.log("上一版保留在：" + backup);
