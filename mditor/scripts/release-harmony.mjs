// release-harmony.mjs —— 出 AGC 上架用 release .app 包（构建 + 发布签名）。
//
// 与 sign-and-install.mjs 的区别：那边出 debug 签名 HAP 装真机（内测），
// 这里出 release 签名 .app 上传 AppGallery Connect（上架）。发布 Profile
// 不含 UDID，产物可装任何设备，因此签名材料绝不能入库（.gitignore 已覆盖）。
//
// 前置（一次性，见 docs/harmony-release.md）：
//   harmony/signing/mditor-release.p12   发布密钥库（generate-keypair 生成）
//   harmony/signing/mditor-release.cer   AGC 发布证书（CSR 上传 AGC 换取）
//   harmony/signing/release.p7b          AGC 发布 Profile（绑定 com.mditor.app）
//   环境变量 MDITOR_RELEASE_KEYSTORE_PWD  发布密钥库密码（不写死在仓库）
//
// 运行：
//   node scripts/release-harmony.mjs              构建 + 签名 → signing/*.app
//   node scripts/release-harmony.mjs --build-only 仅构建 unsigned .app（无证书也可跑）

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const buildOnly = process.argv.includes("--build-only");

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const harmony = join(root, "harmony");
const signing = join(harmony, "signing");

// CLT 位置优先读环境变量（CI 注入），本机默认不变。
const CLT = process.env.HARMONY_CLT_HOME ?? "C:\\Huawei\\command-line-tools";
const SIGN_TOOL_JAR = join(CLT, "sdk", "default", "openharmony", "toolchains", "lib", "hap-sign-tool.jar");
const JAVA_CANDIDATES = [
  process.env.JAVA_HOME,
  "C:\\Program Files\\Eclipse Adoptium\\jdk-17.0.20.101-hotspot",
].filter(Boolean);

function detectJavaHome() {
  for (const home of JAVA_CANDIDATES) {
    if (existsSync(join(home, "bin", "java.exe"))) return home;
  }
  return null;
}

// versionName 从 AppScope/app.json5 解析（单一事实源，避免脚本里再抄一份版本号）。
const appJson5 = readFileSync(join(harmony, "AppScope", "app.json5"), "utf-8");
const versionName = appJson5.match(/"?versionName"?\s*:\s*"([^"]+)"/)?.[1];
if (!versionName) {
  console.error("无法从 harmony/AppScope/app.json5 解析 versionName");
  process.exit(1);
}

// .app 是项目级产物（区别于 entry 模块下的 unsigned HAP），命名随 product。
const unsignedApp = join(harmony, "build", "outputs", "default", "harmony-default-unsigned.app");
const signedApp = join(signing, `Mditor_${versionName}_harmony-release.app`);

function step(name) {
  console.log(`\n=== ${name} ===`);
}

// .app 打包的是 rawfile/web 里已构建好的前端，缺失说明还没跑过 build:harmony。
const webIndex = join(harmony, "entry", "src", "main", "resources", "rawfile", "web", "index.html");
if (!existsSync(webIndex)) {
  console.error(`rawfile/web/index.html 缺失：${webIndex}`);
  console.error("先跑 npm run build:harmony 刷新前端产物，再回来跑本脚本。");
  process.exit(1);
}

// 1) hvigorw assembleApp（release 模式，AGC 只收 release 包）
step("hvigorw assembleApp（release，未签名）");
const isWin = process.platform === "win32";
const hvigorCmd = isWin ? join(CLT, "bin", "hvigorw.bat") : "hvigorw";
const CLT_BIN = join(CLT, "bin");
const OHPM_BIN = join(CLT, "ohpm", "bin");
const javaHome = detectJavaHome();
if (!javaHome) {
  console.error("找不到 JDK 17（hvigorw 需要）；先安装 Temurin 17 或设 JAVA_HOME。");
  process.exit(1);
}
// assembleApp 是项目级任务（--mode module 下不存在，实测 00306054）。
execFileSync(hvigorCmd, ["assembleApp", "--mode", "project", "-p", "product=default", "-p", "buildMode=release"], {
  stdio: "inherit",
  cwd: harmony,
  // Node 24 安全策略：.cmd/.bat 必须经 shell 启动；路径显式补齐（AGENTS.md 已知限制）。
  shell: isWin,
  env: {
    ...process.env,
    PATH: [CLT_BIN, OHPM_BIN, join(javaHome, "bin"), process.env.PATH].join(isWin ? ";" : ":"),
    DEVECO_SDK_HOME: process.env.DEVECO_SDK_HOME ?? join(CLT, "sdk"),
    JAVA_HOME: javaHome,
  },
});

if (!existsSync(unsignedApp)) {
  console.error(`未签名 .app 不存在：${unsignedApp}（检查上方 hvigor 日志）`);
  process.exit(1);
}
const kb = Math.round(statSync(unsignedApp).size / 1024);
console.log(`\n✅ 未签名 .app：${unsignedApp}（${kb} KB）`);

if (buildOnly) {
  console.log("\n--build-only：跳过签名。上架前按 docs/harmony-release.md 备齐发布签名材料后重跑。");
  process.exit(0);
}

// 2) 发布签名（参数与 sign-and-install.mjs 的 debug 流程一致，已验证可用）
const KEY_ALIAS = process.env.MDITOR_RELEASE_KEY_ALIAS ?? "mditor-release";
const KEY_PWD = process.env.MDITOR_RELEASE_KEYSTORE_PWD;
const materials = {
  密钥库: join(signing, "mditor-release.p12"),
  发布证书: join(signing, "mditor-release.cer"),
  发布Profile: join(signing, "release.p7b"),
};
let missing = Object.entries(materials).filter(([, f]) => !existsSync(f));
if (missing.length > 0 || !KEY_PWD) {
  for (const [name, f] of missing) console.error(`缺少发布签名材料（${name}）：${f}`);
  if (!KEY_PWD) console.error("缺少环境变量 MDITOR_RELEASE_KEYSTORE_PWD（发布密钥库密码）。");
  console.error("申请步骤见 docs/harmony-release.md；仅想先出包用 --build-only。");
  process.exit(1);
}

if (!existsSync(SIGN_TOOL_JAR)) {
  console.error(`找不到 hap-sign-tool.jar：${SIGN_TOOL_JAR}（检查 HARMONY_CLT_HOME）`);
  process.exit(1);
}
const java = join(javaHome, "bin", "java.exe");

// N5：hap-sign-tool 实测不支持口令文件/stdin 传参（java -jar ... -h 全量帮助
// 只有 -keyPwd/-keystorePwd；反编译全 jar 无 pwdFile/getenv/extCfg 消费方），
// 口令只能经 argv 传给 java——本机进程列表瞬时可见，仅在可信机器上签名。
// 能兜底的是失败路径：execFileSync 抛错时 Node 会把完整命令行（含口令）拼进
// error.message，必须脱敏后再输出，绝不进控制台/CI 日志。
function run(args) {
  console.log(`> java ${args.join(" ").replaceAll(KEY_PWD, "******")}`);
  try {
    execFileSync(java, args, { stdio: "inherit", windowsHide: true });
  } catch (e) {
    // stdio: inherit 下子进程输出直达终端，error 对象里主要是 message；
    // stdout/stderr/cmd 若存在（如日后改 pipe）也一并处理，Buffer 同样覆盖。
    for (const field of ["message", "stdout", "stderr", "cmd"]) {
      const value = e?.[field];
      if (typeof value === "string" && value.includes(KEY_PWD)) {
        e[field] = value.replaceAll(KEY_PWD, "******");
      } else if (Buffer.isBuffer(value) && value.toString("utf-8").includes(KEY_PWD)) {
        e[field] = value.toString("utf-8").replaceAll(KEY_PWD, "******");
      }
    }
    console.error(`签名失败：${e?.message ?? e}`);
    process.exit(1);
  }
}

step("sign-app（发布签名）");
run([
  "-jar", SIGN_TOOL_JAR, "sign-app",
  "-mode", "localSign",
  "-keyAlias", KEY_ALIAS,
  "-keyPwd", KEY_PWD,
  "-keystoreFile", materials.密钥库,
  "-keystorePwd", KEY_PWD,
  "-signAlg", "SHA256withECDSA",
  "-profileFile", materials.发布Profile,
  "-appCertFile", materials.发布证书,
  "-profileSigned", "1",
  "-inFile", unsignedApp,
  "-compatibleVersion", "22",
  "-outFile", signedApp,
]);

const skb = Math.round(statSync(signedApp).size / 1024);
console.log(`\n🎉 已签名 release 包：${signedApp}（${skb} KB）`);
console.log("   下一步：上传 AGC → 版本管理，步骤见 docs/harmony-release.md");
