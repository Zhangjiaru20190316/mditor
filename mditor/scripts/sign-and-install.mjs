// sign-and-install.mjs —— 调试签名 + hdc 安装一步完成（配合 AGC 证书材料）。
//
// 前置（一次性，见 harmony/README.md「签名与真机部署」）：
//   harmony/signing/mditor-debug.p12   本地密钥对（已生成）
//   harmony/signing/mditor-debug.cer   AGC 调试证书（用户上传 CSR 换取）
//   harmony/signing/debug.p7b          AGC 调试 Profile（含设备 UDID）
// 运行：MDITOR_DEBUG_KEYSTORE_PWD=<口令> node scripts/sign-and-install.mjs
//   产出 signing/mditor-signed.hap 并 hdc install。

import { execFileSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const signing = join(root, "harmony", "signing");
const unsignedHap = join(root, "harmony", "entry", "build", "default", "outputs", "default", "entry-default-unsigned.hap");
const signedHap = join(signing, "mditor-signed.hap");

// S8：凭据与机器特定路径全部改环境变量（release-harmony.mjs / build-harmony.mjs
// 已建立的同款纪律）。仓库内不再出现任何密钥常量；路径可被 env 覆盖，
// 缺省回退到本机安装位置（本机零配置继续工作，其他机器设置 env 即可）。
const KEY_ALIAS = process.env.MDITOR_DEBUG_KEY_ALIAS ?? "mditor-debug";
const KEY_PWD = process.env.MDITOR_DEBUG_KEYSTORE_PWD ?? "";
if (!KEY_PWD) {
  console.error("缺少签名口令：请设置环境变量 MDITOR_DEBUG_KEYSTORE_PWD 后重试。");
  console.error("（口令不再提交进仓库——见优化报告 S8）");
  process.exit(1);
}
const HARMONY_CLT_HOME = process.env.HARMONY_CLT_HOME ?? "C:\\Huawei\\command-line-tools";
const JAR =
  process.env.HAP_SIGN_TOOL_JAR ??
  join(HARMONY_CLT_HOME, "sdk", "default", "openharmony", "toolchains", "lib", "hap-sign-tool.jar");
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

// N5：hap-sign-tool 实测不支持口令文件/stdin 传参（java -jar ... -h 全量帮助
// 只有 -keyPwd/-keystorePwd；反编译全 jar 无 pwdFile/getenv/extCfg 消费方），
// 口令只能经 argv 传给 java——本机进程列表瞬时可见，仅在可信机器上签名。
// 能兜底的是失败路径：execFileSync 抛错时 Node 会把完整命令行（含口令）拼进
// error.message，必须脱敏后再输出，绝不进控制台/CI 日志。
// G3：catch 变量为 unknown，取字段/回写均为 any 视图转换（纯注解，脱敏逻辑不变）。
/** @param {string[]} args */
function run(args) {
  console.log(`> java ${args.join(" ").replaceAll(KEY_PWD, "******")}`);
  try {
    execFileSync(java, args, { stdio: "inherit", windowsHide: true });
  } catch (e) {
    // stdio: inherit 下子进程输出直达终端，error 对象里主要是 message；
    // stdout/stderr/cmd 若存在（如日后改 pipe）也一并处理，Buffer 同样覆盖。
    for (const field of ["message", "stdout", "stderr", "cmd"]) {
      const value = /** @type {any} */ (e)?.[field];
      if (typeof value === "string" && value.includes(KEY_PWD)) {
        /** @type {any} */ (e)[field] = value.replaceAll(KEY_PWD, "******");
      } else if (Buffer.isBuffer(value) && value.toString("utf-8").includes(KEY_PWD)) {
        /** @type {any} */ (e)[field] = value.toString("utf-8").replaceAll(KEY_PWD, "******");
      }
    }
    console.error(`签名失败：${/** @type {any} */ (e)?.message ?? e}`);
    process.exit(1);
  }
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
const hdc =
  process.env.HDC_EXE ??
  join(HARMONY_CLT_HOME, "sdk", "default", "openharmony", "toolchains", "hdc.exe");
execFileSync(hdc, ["install", "-r", signedHap], { stdio: "inherit", shell: false });
console.log("\n🎉 安装完成。在设备的桌面/启动器找「Mditor」。");
