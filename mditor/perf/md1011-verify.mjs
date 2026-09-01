// MD-1011 实机验证：在 dev 实例（CDP）里反复执行「打开标题密集文档 + 切标签
// 回来」——旧版每次必触发 pm:rebuild（removed = 2×标题数+1）；修复后应为零。
// 前置：WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9223
//       npx tauri dev --config src-tauri/tauri.dev.conf.json
import { findPageTarget, Cdp, mouse, sleep } from "./cdp.mjs";
import { readFileSync } from "node:fs";

const EVLOG =
  "C:/Users/hh/AppData/Roaming/com.mditor.app.dev/logs/dev-events.log";

const tailRebuilds = () =>
  readFileSync(EVLOG, "utf8")
    .split("\n")
    .filter((l) => l.includes('"kind":"pm:rebuild"')).length;

const target = await findPageTarget(9223);
const cdp = await Cdp.connect(target.webSocketDebuggerUrl);
const m = mouse(cdp);

/** 打开文件树里名字含 name 的文档（沿用 baseline.mjs 的交互路径）。 */
async function openDoc(name) {
  await cdp.eval(`(() => {
    const btn = document.querySelector('button.mb-btn');
    return !!btn;
  })()`);
  // 侧栏若关着先打开（Ctrl+\ 是全局快捷键，此处直接点文件树按钮）。
  await cdp.eval(`(() => {
    const host = document.querySelector('.mditor-editor-host');
    return host ? host.dataset.mode : null;
  })()`);
  const r = await cdp.eval(`(() => {
    const rows = [...document.querySelectorAll('.ft-row.ft-file')];
    const hit = rows.find((row) =>
      (row.querySelector('.ft-name')?.textContent ?? '').includes('${name}')
    );
    if (!hit) return null;
    hit.scrollIntoView({ block: 'center' });
    const rc = hit.getBoundingClientRect();
    return { x: Math.round(rc.x + 80), y: Math.round(rc.y + rc.height / 2) };
  })()`);
  if (!r) throw new Error(`file-tree row not found: ${name}`);
  await m.click(r.x, r.y);
}

const before = tailRebuilds();
console.log("pm:rebuild baseline in log:", before);

// 轮次 1-3：打开 A → 打开 B → 点 A 的标签切回（整篇 flush 重载路径 ×2/轮）。
for (let i = 0; i < 3; i++) {
  await openDoc("CMC备战");
  await sleep(3500);
  await openDoc("1MB压测副本");
  await sleep(3500);
  // 切回 A：点 tabbar 标签（或再点文件树行，同语义）。
  await openDoc("CMC备战");
  await sleep(3500);
  const blocks = await cdp.eval(`(() => {
    const pm = document.querySelector('.ProseMirror');
    return pm ? pm.children.length : 0;
  })()`);
  console.log(`round ${i + 1} done, blocks now:`, blocks);
}

await sleep(2000);
const after = tailRebuilds();
console.log(`\npm:rebuild events: ${before} → ${after} (delta ${after - before})`);
console.log(
  after - before === 0
    ? "PASS：整篇重载不再批量替换顶层块"
    : "FAIL：仍出现 pm:rebuild，见 dev-events.log 尾部"
);
