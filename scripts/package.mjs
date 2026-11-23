import { signingOptions } from "./signing.mjs";
import { execFileSync } from "node:child_process";
import {
  cpSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  renameSync,
} from "node:fs";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
const root = fileURLToPath(new URL("..", import.meta.url));
const require = createRequire(import.meta.url);
const manifest = JSON.parse(readFileSync(root + "/package.json", "utf8"));
const electron = require("electron");
const base = electron.slice(0, electron.indexOf("/Contents/MacOS/"));
const app = root + "/dist/微响.app";
mkdirSync(root + "/dist", { recursive: true });
if (existsSync(app))
  throw new Error(
    "dist/微响.app 已存在。请先移走旧版本，再重新构建，避免覆盖正在使用的软件。",
  );
cpSync(base, app, { recursive: true, verbatimSymlinks: true });
const resources = app + "/Contents/Resources";
mkdirSync(resources + "/app", { recursive: true });
cpSync(root + "/app", resources + "/app/app", { recursive: true });
writeFileSync(
  resources + "/app/package.json",
  JSON.stringify({
    name: "huixiang-desktop",
    productName: manifest.productName,
    version: manifest.version,
    main: "app/main.cjs",
  }),
);
mkdirSync(resources + "/native", { recursive: true });
cpSync(
  root + "/native/bin/HuixiangBridge",
  resources + "/native/HuixiangBridge",
);
cpSync(
  root + "/native/bin/MacControl.node",
  resources + "/native/MacControl.node",
);
cpSync(root + "/README.md", resources + "/app/README.md");
cpSync(
  root + "/node_modules/electron/dist/LICENSE",
  resources + "/Electron-LICENSE",
);
cpSync(
  root + "/node_modules/electron/dist/LICENSES.chromium.html",
  resources + "/LICENSES.chromium.html",
);
execFileSync("swift", [root + "/scripts/Icon.swift", root + "/dist/icon.png"]);
const iconset = root + "/dist/AppIcon.iconset";
mkdirSync(iconset, { recursive: true });
for (const size of [16, 32, 128, 256, 512]) {
  execFileSync(
    "sips",
    [
      "-z",
      String(size),
      String(size),
      root + "/dist/icon.png",
      "--out",
      `${iconset}/icon_${size}x${size}.png`,
    ],
    { stdio: "ignore" },
  );
  execFileSync(
    "sips",
    [
      "-z",
      String(size * 2),
      String(size * 2),
      root + "/dist/icon.png",
      "--out",
      `${iconset}/icon_${size}x${size}@2x.png`,
    ],
    { stdio: "ignore" },
  );
}
execFileSync("iconutil", [
  "-c",
  "icns",
  iconset,
  "-o",
  resources + "/AppIcon.icns",
]);
const plist = app + "/Contents/Info.plist";
for (const [key, value] of Object.entries({
  CFBundleIdentifier: "com.huixiang.desktop",
  CFBundleName: manifest.productName,
  CFBundleDisplayName: "微响",
  CFBundleExecutable: "Huixiang",
  CFBundleShortVersionString: manifest.version,
  CFBundleVersion: "1",
  CFBundleIconFile: "AppIcon.icns",
  NSHumanReadableCopyright: "微响 · 本地预览版",
  NSCameraUsageDescription: "微响不使用摄像头",
  NSMicrophoneUsageDescription: "微响不使用麦克风",
})) {
  try {
    execFileSync(
      "/usr/libexec/PlistBuddy",
      ["-c", `Set :${key} ${value}`, plist],
      { stdio: "pipe" },
    );
  } catch {
    execFileSync("/usr/libexec/PlistBuddy", [
      "-c",
      `Add :${key} string ${value}`,
      plist,
    ]);
  }
}
execFileSync("/usr/libexec/PlistBuddy", [
  "-c",
  "Add :NSScreenCaptureUsageDescription string 微响读取你选定的微信窗口，用于识别消息并准备回复。",
  plist,
]);
renameSync(app + "/Contents/MacOS/Electron", app + "/Contents/MacOS/Huixiang");
execFileSync("codesign", ["--force", "--deep", ...signingOptions(), app], {
  stdio: "inherit",
});
execFileSync("codesign", ["--verify", "--deep", "--strict", app], {
  stdio: "inherit",
});
console.log("已生成：" + app);
