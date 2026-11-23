import { signingOptions } from "./signing.mjs";
const signing = signingOptions();
import { execFileSync } from "node:child_process";
import { mkdirSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
const root = fileURLToPath(new URL("..", import.meta.url));
mkdirSync(root + "/native/bin", { recursive: true });
execFileSync(
  "swiftc",
  [
    "-parse-as-library",
    "-O",
    "-target",
    "arm64-apple-macosx14.0",
    root + "/native/WeChatBridge.swift",
    "-o",
    root + "/native/bin/HuixiangBridge",
    "-framework",
    "AppKit",
    "-framework",
    "ScreenCaptureKit",
    "-framework",
    "Vision",
    "-framework",
    "ApplicationServices",
    "-framework",
    "PDFKit",
  ],
  { stdio: "inherit" },
);
execFileSync(
  "codesign",
  ["--force", ...signing, root + "/native/bin/HuixiangBridge"],
  { stdio: "inherit" },
);
const headers = [
  process.env.HUIXIANG_NODE_HEADERS,
  path.resolve(path.dirname(process.execPath), "../include/node"),
  "/opt/homebrew/include/node",
  "/usr/local/include/node",
]
  .filter(Boolean)
  .find((p) => existsSync(path.join(p, "node_api.h")));
if (!headers)
  throw new Error(
    "未找到 Node-API 头文件，请安装 Node 开发头文件并设置 HUIXIANG_NODE_HEADERS",
  );
execFileSync(
  "clang++",
  [
    "-std=c++17",
    "-fobjc-arc",
    "-DNAPI_VERSION=8",
    "-arch",
    "arm64",
    "-mmacosx-version-min=14.0",
    "-bundle",
    "-undefined",
    "dynamic_lookup",
    "-I",
    headers,
    "-framework",
    "ScreenCaptureKit",
    root + "/native/MacControl.mm",
    "-o",
    root + "/native/bin/MacControl.node",
    "-framework",
    "AppKit",
    "-framework",
    "ApplicationServices",
  ],
  { stdio: "inherit" },
);
execFileSync(
  "codesign",
  ["--force", ...signing, root + "/native/bin/MacControl.node"],
  { stdio: "inherit" },
);
console.log("本机微信组件已构建（键鼠操作使用微响主进程权限）");
