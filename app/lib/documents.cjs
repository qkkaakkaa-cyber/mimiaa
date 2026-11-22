const fs = require("node:fs");
const path = require("node:path");
const { execFile } = require("node:child_process");
async function readBusinessDocument(file, helper) {
  const extension = path.extname(file).toLowerCase();
  if (![".txt", ".md", ".pdf", ".docx"].includes(extension))
    throw new Error("支持 TXT、Markdown、PDF 和 Word 文档");
  if (fs.statSync(file).size > 5 * 1024 * 1024)
    throw new Error("单份资料请控制在 5MB 以内");
  let text;
  if ([".txt", ".md"].includes(extension)) text = fs.readFileSync(file, "utf8");
  else if (extension === ".pdf")
    text = (await helper.request("extract-document", { path: file })).text;
  else
    text = await new Promise((resolve, reject) =>
      execFile(
        "/usr/bin/textutil",
        ["-convert", "txt", "-stdout", file],
        { maxBuffer: 4 * 1024 * 1024, timeout: 15000 },
        (error, out) =>
          error
            ? reject(new Error("无法读取该 Word 文档，请另存为 TXT 后导入"))
            : resolve(out),
      ),
    );
  if (!text || !text.trim())
    throw new Error("没有提取到文字；扫描版资料请先转成文字文档");
  return { name: path.basename(file), text: text.slice(0, 80000) };
}
module.exports = { readBusinessDocument };
