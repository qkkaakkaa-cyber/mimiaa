import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, accessSync, constants, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
const root = fileURLToPath(new URL("..", import.meta.url)),
  source = root + "/dist/微响.app",
  target = "/Applications/回响.app";
if (!existsSync(source)) throw new Error("请先构建应用包");
accessSync("/Applications", constants.W_OK);
execFileSync("codesign", ["--verify", "--deep", "--strict", source]);
let backup = "";
if (existsSync(target)) {
  const id = execFileSync(
    "/usr/libexec/PlistBuddy",
    ["-c", "Print :CFBundleIdentifier", target + "/Contents/Info.plist"],
    { encoding: "utf8" },
  ).trim();
  if (id !== "com.huixiang.desktop")
    throw new Error("已有其他同名应用，停止更新");
  const dir = root + "/dist/backups";
  mkdirSync(dir, { recursive: true });
  backup =
    dir +
    "/Huixiang-" +
    new Date().toISOString().replace(/[:.]/g, "-") +
    ".zip";
  execFileSync("/usr/bin/ditto", ["-c", "-k", "--keepParent", target, backup]);
}
try {
  // Preserve the installed bundle path. Renaming the old bundle to another .app
  // caused System Settings to follow that old app instead of the new install.
  if (backup)
    rmSync(target + "/Contents/Resources/app/app", {
      recursive: true,
      force: true,
    });
  execFileSync("/usr/bin/ditto", [source, target]);
  execFileSync("codesign", ["--verify", "--deep", "--strict", target]);
} catch (error) {
  if (backup) {
    rmSync(target + "/Contents/Resources/app/app", {
      recursive: true,
      force: true,
    });
    execFileSync("/usr/bin/ditto", ["-x", "-k", backup, "/Applications"]);
  }
  throw error;
}
console.log("已更新：" + target);
if (backup) console.log("可回退备份：" + backup);
