// build-harmony.mjs —— 一条命令出鸿蒙 HAP（鸿蒙迁移 v4.11 阶段 2）。
//
// 链路：vite build --base ./（相对路径，rawfile 下资源 404 的唯一解）
//   → 拷贝 dist/ → harmony/entry/src/main/resources/rawfile/web/
//   → harmony/ 下 ohpm install（幂等）+ hvigorw assembleHap（未签名）
//
// Node 编写、跨 shell 稳定（Windows Git Bash / CMD / PowerShell 一致）。
// 工具链位置与版本核验见 memory/2026-09-13.md（CLT 6.0.2.670，API 22）。

import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, rmSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dist = join(root, "dist");
const webOut = join(root, "harmony", "entry", "src", "main", "resources", "rawfile", "web");
const harmony = join(root, "harmony");

// CLT 位置优先读环境变量（CI 的 release.yml 注入），本机默认不变。
const CLT = process.env.HARMONY_CLT_HOME ?? "C:\\Huawei\\command-line-tools";
const CLT_BIN = join(CLT, "bin");
const OHPM_BIN = join(CLT, "ohpm", "bin");
// 打包/签名工具为 Java 实现（风险表 §8 预案）：自动探测常见 Temurin 安装。
const JAVA_CANDIDATES = [
  process.env.JAVA_HOME,
  "C:\\Program Files\\Eclipse Adoptium\\jdk-17.0.20.101-hotspot",
].filter(Boolean);

function detectJavaHome() {
  for (const home of JAVA_CANDIDATES) {
    const exe = join(home, "bin", isWin ? "java.exe" : "java");
    if (existsSync(exe)) return home;
  }
  return null;
}

const isWin = process.platform === "win32";
const npmCmd = isWin ? "npm.cmd" : "npm";
const ohpmCmd = isWin ? join(OHPM_BIN, "ohpm.bat") : "ohpm";
const hvigorCmd = isWin ? join(CLT_BIN, "hvigorw.bat") : "hvigorw";

function buildEnv() {
  const env = {
    ...process.env,
    // 新开 shell 可能未继承用户 PATH（AGENTS.md 已知限制），这里显式补上。
    PATH: [CLT_BIN, OHPM_BIN, process.env.PATH].join(isWin ? ";" : ":"),
    DEVECO_SDK_HOME: process.env.DEVECO_SDK_HOME ?? join(CLT, "sdk"),
  };
  const javaHome = detectJavaHome();
  if (javaHome) {
    // 必须 Windows 格式：hvigorw.bat（Node）直接以 JAVA_HOME 定位 java。
    env.JAVA_HOME = javaHome;
    env.PATH = [join(javaHome, "bin"), env.PATH].join(isWin ? ";" : ":");
  }
  return env;
}

function run(cmd, args, opts = {}) {
  console.log(`> ${cmd} ${args.join(" ")}`);
  // Node 24 安全策略：.cmd/.bat 必须经 shell 启动（否则 spawn EINVAL）。
  const needsShell = isWin && /\.(cmd|bat)$/i.test(cmd);
  execFileSync(cmd, args, {
    stdio: "inherit",
    cwd: opts.cwd ?? root,
    env: buildEnv(),
    shell: opts.shell ?? needsShell,
  });
}

function step(name) {
  console.log(`\n=== ${name} ===`);
}

// 1) 前端构建（--base ./：ArkWeb 从 rawfile 加载，资源必须相对路径引用）
step("vite build（base=./）");
run(npmCmd, ["run", "build:harmony-web"]);

// 2) 产物拷贝 → rawfile/web（全量替换，避免残留旧 hash 文件）
step("拷贝 dist/ → rawfile/web");
if (!existsSync(dist)) {
  console.error(`dist/ 不存在：${dist}`);
  process.exit(1);
}
rmSync(webOut, { recursive: true, force: true });
mkdirSync(webOut, { recursive: true });
cpSync(dist, webOut, { recursive: true });
const html = join(webOut, "index.html");
if (!existsSync(html)) {
  console.error(`rawfile/web/index.html 缺失：${html}`);
  process.exit(1);
}

// 3) 依赖安装（幂等；oh_modules 存在时 ohpm install 增量校验很快）
step("ohpm install");
run(ohpmCmd, ["install"], { cwd: harmony });

// 4) 打未签名 HAP（签名证书就绪后改用 assembleHap + signingConfig，见
//    harmony/README.md「签名与真机部署」）
step("hvigorw assembleHap（未签名）");
run(hvigorCmd, ["assembleHap", "--mode", "module", "-p", "product=default"], {
  cwd: harmony,
});

// 5) 产物定位与体积汇报
step("产物");
const outDir = join(harmony, "entry", "build", "default", "outputs", "default");
const candidates = ["entry-default-unsigned.hap"];
let found = null;
for (const c of candidates) {
  const p = join(outDir, c);
  if (existsSync(p)) {
    found = p;
    break;
  }
}
if (found) {
  const kb = Math.round(statSync(found).size / 1024);
  console.log(`\n✅ 未签名 HAP：${found}（${kb} KB）`);
  console.log("   签名与真机部署步骤见 harmony/README.md");
} else {
  console.error(`\n⚠️ 未在 ${outDir} 找到产物 HAP，请检查上方 hvigor 日志`);
  process.exit(1);
}
