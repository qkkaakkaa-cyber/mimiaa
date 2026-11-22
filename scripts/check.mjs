import { execFileSync } from "node:child_process";
import { readdirSync } from "node:fs";
function walk(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(dir + "/" + e.name) : [dir + "/" + e.name],
  );
}
for (const file of walk("app").filter((f) => /\.(?:js|cjs)$/.test(f)))
  execFileSync(process.execPath, ["--check", file], { stdio: "inherit" });
console.log("所有脚本语法检查通过");
