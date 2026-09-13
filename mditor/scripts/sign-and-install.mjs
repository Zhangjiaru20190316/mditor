// sign-and-install.mjs —— 调试签名 + hdc 安装一步完成（配合 AGC 证书材料）。
//
// 前置（一次性，见 harmony/README.md「签名与真机部署」）：
//   harmony/signing/mditor-debug.p12   本地密钥对（已生成）
//   harmony/signing/mditor-debug.cer   AGC 调试证书（用户上传 CSR 换取）
//   harmony/signing/debug.p7b          AGC 调试 Profile（含设备 UDID）
// 运行：node scripts/sign-and-install.mjs
//   产出 signing/mditor-signed.hap 并 hdc install。

import { execFileSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const signing = join(root, "harmony", "signing");
const unsignedHap = join(root, "harmony", "entry", "build", "default", "outputs", "default", "entry-default-unsigned.hap");
const signedHap = join(signing, "mditor-signed.hap");

const KEY_ALIAS = "mditor-debug";
const KEY_PWD = "mditor-debug-2026"; // 本地调试密钥，非机密
const JAR = "C:\\Huawei\\command-line-tools\\sdk\\default\\openharmony\\toolchains\\lib\\hap-sign-tool.jar";
const JAVA_CANDIDATES = [
  process.env.JAVA_HOME,
  "C:\\Program Files\\Eclipse Adoptium\\jdk-17.0.20.101-hotspot",
];

for (const f of [join(signing, "mditor-debug.cer"), join(signing, "debug.p7b")]) {
  if (!existsSync(f)) {
    console.error(`缺少签名材料：${f}`);
    console.error("按 harmony/README.md「AGC 手动申请」下载后放到 harmony/signing/ 再运行。");
    process.exit(1);
  }
}
if (!existsSync(unsignedHap)) {
  console.error(`未签名 HAP 不存在：${unsignedHap}（先跑 npm run build:harmony）`);
  process.exit(1);
}

const javaHome = JAVA_CANDIDATES.find((h) => h && existsSync(join(h, "bin", "java.exe")));
if (!javaHome) {
  console.error("找不到 JDK 17（需要 hap-sign-tool）；先安装 Temurin 17 或设 JAVA_HOME。");
  process.exit(1);
}
const java = join(javaHome, "bin", "java.exe");

function run(args) {
  console.log(`> java ${args.join(" ").replace(KEY_PWD, "******")}`);
  execFileSync(java, args, { stdio: "inherit" });
}

console.log("=== sign-app（调试签名）===");
run([
  "-jar", JAR, "sign-app",
  "-mode", "localSign",
  "-keyAlias", KEY_ALIAS,
  "-keyPwd", KEY_PWD,
  "-keystoreFile", join(signing, "mditor-debug.p12"),
  "-keystorePwd", KEY_PWD,
  "-signAlg", "SHA256withECDSA",
  "-profileFile", join(signing, "debug.p7b"),
  "-appCertFile", join(signing, "mditor-debug.cer"),
  "-profileSigned", "1",
  "-inFile", unsignedHap,
  "-compatibleVersion", "22",
  "-outFile", signedHap,
]);

const kb = Math.round(statSync(signedHap).size / 1024);
console.log(`\n✅ 已签名：${signedHap}（${kb} KB）`);

console.log("\n=== hdc install ===");
const hdc = "C:\\Huawei\\command-line-tools\\sdk\\default\\openharmony\\toolchains\\hdc.exe";
execFileSync(hdc, ["install", "-r", signedHap], { stdio: "inherit", shell: false });
console.log("\n🎉 安装完成。在设备的桌面/启动器找「Mditor」。");
