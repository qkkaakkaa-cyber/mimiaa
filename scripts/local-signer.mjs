import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  existsSync,
  writeFileSync,
  readFileSync,
  rmSync,
  mkdtempSync,
  chmodSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { randomBytes } from "node:crypto";
import path from "node:path";
// This isolated keychain contains only this app's new build-signing key.
// Never change the login keychain or trust settings. TCC still requires the
// normal System Settings grant for the installed app.
export function localSigner() {
  const dir = path.join(homedir(), "Library/Application Support/HuixiangBuild");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const config = path.join(dir, "signer.json"),
    keychain = path.join(dir, "signing.keychain-db");
  const run = (bin, args) =>
    execFileSync(bin, args, { stdio: "pipe", encoding: "utf8" });
  if (!existsSync(config)) {
    if (existsSync(keychain))
      throw new Error("存在未完成的签名密钥库，保留原文件并停止");
    const password = randomBytes(30).toString("base64url"),
      temp = mkdtempSync(path.join(tmpdir(), "huixiang-signing-"));
    try {
      const key = path.join(temp, "key.pem"),
        cert = path.join(temp, "cert.pem"),
        p12 = path.join(temp, "signer.p12");
      run("openssl", [
        "req",
        "-x509",
        "-newkey",
        "rsa:2048",
        "-keyout",
        key,
        "-out",
        cert,
        "-nodes",
        "-days",
        "3650",
        "-subj",
        "/CN=Huixiang Local Development",
        "-addext",
        "keyUsage=critical,digitalSignature",
        "-addext",
        "extendedKeyUsage=codeSigning",
      ]);
      run("openssl", [
        "pkcs12",
        "-export",
        "-inkey",
        key,
        "-in",
        cert,
        "-out",
        p12,
        "-passout",
        "pass:" + password,
      ]);
      run("security", ["create-keychain", "-p", password, keychain]);
      run("security", ["unlock-keychain", "-p", password, keychain]);
      run("security", [
        "import",
        p12,
        "-k",
        keychain,
        "-P",
        password,
        "-T",
        "/usr/bin/codesign",
      ]);
      run("security", [
        "set-key-partition-list",
        "-S",
        "apple-tool:,apple:,codesign:",
        "-s",
        "-k",
        password,
        keychain,
      ]);
      const fingerprint = run("openssl", [
        "x509",
        "-in",
        cert,
        "-noout",
        "-fingerprint",
        "-sha1",
      ])
        .split("=")
        .at(-1)
        .replace(/:/g, "")
        .trim();
      writeFileSync(
        config,
        JSON.stringify({ identity: fingerprint, keychain, password }),
        { mode: 0o600 },
      );
      chmodSync(keychain, 0o600);
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  }
  const signer = JSON.parse(readFileSync(config, "utf8"));
  run("security", ["unlock-keychain", "-p", signer.password, signer.keychain]);
  return { identity: signer.identity, keychain: signer.keychain };
}
