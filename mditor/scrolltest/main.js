// 滚动修复运行时验证页（独立于 Tauri 壳，纯 Web 复现代码块懒生命周期场景）。
//
// 验证 patch-package 对 @milkdown/components code-block 的三处修改：
//   V1 teardown 高度冻结：离带拆除后块高不变（占位符 min-height = 拆除前实测高）
//   V2 贴底钳制稳定：上方块拆除不再造成贴底 scrollTop 回弹
//   V3 程序化写入不劫持滚动：未聚焦 CM 收到内容更新不再 scrollIntoView 宿主
//
// IO 由 scrolltest.html 预装的可控桩驱动（__ioFire），组件代码路径不变。
// 页面自跑完整序列，结果挂在 window.__scrollTest.result，外部只读轮询。

import { Crepe } from "@milkdown/crepe";
import { editorViewCtx } from "@milkdown/core";
import { syntaxHighlighting } from "@codemirror/language";
import { classHighlighter } from "@lezer/highlight";
import { TextSelection } from "@milkdown/kit/prose/state";
import "@milkdown/crepe/theme/common/style.css";
import "@milkdown/crepe/theme/nord.css";
import "/src/styles/global.css";

const host = document.getElementById("host");
const milk = document.getElementById("milk");
const bar = document.getElementById("bar");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const say = (s) => {
  bar.textContent = s;
};
const ioEnter = (el) => window.__ioFire(el, true);
const ioLeave = (el) => window.__ioFire(el, false);

// 抓组件内未处理异常，供外部读取定位失败原因。
window.__errs = [];
window.addEventListener("error", (e) => {
  window.__errs.push(String((e.error && e.error.stack) || e.message));
});
window.addEventListener("unhandledrejection", (e) => {
  window.__errs.push("rejection: " + String((e.reason && e.reason.stack) || e.reason));
});

const R = { steps: [], ok: true };
const step = (name, data) => {
  R.steps.push({ name, ...data });
  say(`${name}: ${JSON.stringify(data)}`);
};
const fail = (name, data) => {
  R.ok = false;
  step(name, { ...data, FAIL: true });
};

function codeBlocks() {
  const pm = host.querySelector(".ProseMirror");
  if (!pm) return [];
  return Array.from(pm.children).filter(
    (el) => el.classList.contains("milkdown-code-block")
  );
}

const py = (i) =>
  [
    `# block ${i}`,
    `def build_model_${i}(name, hidden=64):`,
    `    """docstring line for model ${i} with some more text to widen"""`,
    `    layers = [nn.Linear(hidden, hidden) for _ in range(3)]`,
    `    if name == "cnn":`,
    `        layers.insert(0, nn.Conv2d(1, hidden, 3))`,
    `    return nn.Sequential(*layers)`,
    ``,
    `def fit_${i}(params, epochs=5):`,
    `    for ep in range(epochs):`,
    `        loss = train_one_epoch(params)`,
    `        print(f"epoch {ep}: {loss:.4f}")`,
  ].join("\n");

const para =
  "这一段用于在代码块之间制造足够的垂直间距，模拟真实长文档中代码块相隔数百像素的布局。" +
  "内容本身不重要，重要的是每节都有几段这样的文字，让相邻代码块的距离超出视口加二百像素的观测带。";

const MD = Array.from({ length: 16 }, (_, i) =>
  [
    `## 第 ${i + 1} 节 实验设置`,
    para,
    para,
    "```python\n" + py(i) + "\n```",
    para,
    para,
    para,
  ].join("\n\n")
).join("\n\n");

async function run() {
  window.__scrollTest = { state: "running", result: null };

  const crepe = new Crepe({
    root: milk,
    defaultValue: MD,
    features: {
      [Crepe.Feature.CodeMirror]: true,
      [Crepe.Feature.Latex]: false,
      [Crepe.Feature.TopBar]: false,
      [Crepe.Feature.AI]: false,
    },
    featureConfigs: {
      [Crepe.Feature.CodeMirror]: {
        previewOnlyByDefault: true,
        extensions: [syntaxHighlighting(classHighlighter)],
      },
    },
  });
  await crepe.create();
  await sleep(800);

  // 自动化环境下页面可能从未获得焦点：PM 的 selectionToDOM 只在编辑器
  // 持有焦点时才调 nodeView.setSelection；无焦点时选区驱动的初始化哑火。
  const view = crepe.editor.ctx.get(editorViewCtx);
  try {
    host.querySelector(".ProseMirror").focus();
  } catch {
    /* ignore */
  }

  const blocks = codeBlocks();
  if (blocks.length < 12) {
    fail("setup", { codeBlocks: blocks.length });
    return finish();
  }
  step("setup", { codeBlocks: blocks.length });

  // ---- V1：离带拆除高度冻结 --------------------------------------------
  const target = blocks[4];
  target.scrollIntoView({ block: "start" });
  ioEnter(target); // 进带 → initializeCodeMirror
  await sleep(1200); // CM 挂载 + 语言加载
  const hInit = target.offsetHeight;
  const hasCM = !!target.querySelector(".cm-editor");
  const scrollHInit = host.scrollHeight;
  step("v1-init", { hInit, hasCM, scrollHInit });
  if (!hasCM) {
    fail("v1-init", { reason: "code block did not initialize" });
    return finish();
  }

  host.scrollTop = host.scrollHeight; // 滚去文档底部（模拟用户离开）
  ioLeave(target); // 离带 → scheduleTeardown(30s)
  await sleep(31500); // 越过 TEARDOWN_DELAY(30s) + 余量
  const placeholder = target.querySelector("pre.milkdown-code-block-placeholder");
  const tornDown = !target.querySelector(".cm-editor") && !!placeholder;
  const hAfter = target.offsetHeight;
  const scrollHAfter = host.scrollHeight;
  const frozenH = target.style.height;
  const v1 = tornDown && Math.abs(hAfter - hInit) <= 1 && Math.abs(scrollHAfter - scrollHInit) <= 1;
  v1
    ? step("v1-teardown-frozen", { tornDown, hInit, hAfter, frozenH, scrollHInit, scrollHAfter })
    : fail("v1-teardown-frozen", { tornDown, hInit, hAfter, frozenH, scrollHInit, scrollHAfter });

  // ---- V2：贴底钳制稳定 --------------------------------------------------
  host.scrollTop = host.scrollHeight;
  await sleep(400);
  const stBottom0 = host.scrollTop;
  await sleep(1500);
  const v2 = host.scrollTop === stBottom0;
  v2 ? step("v2-bottom-clamp", { st: stBottom0 }) : fail("v2-bottom-clamp", { st0: stBottom0, st1: host.scrollTop });

  // ---- V3：程序化写入不劫持滚动（未聚焦 CM + 光标在视口外下方） ----------
  const docBlocks = [];
  view.state.doc.descendants((n, p) => {
    if (n.type.name === "code_block") docBlocks.push({ p, n });
    return true;
  });
  const b8 = docBlocks[8];
  if (!b8) {
    fail("v3-setup", { docBlocks: docBlocks.length });
    return finish();
  }
  const endPos = b8.p + 1 + b8.n.textContent.length; // 代码块文本末尾
  const t2 = blocks[8];
  t2.scrollIntoView({ block: "end" }); // 块底贴视口底
  host.scrollTop -= 60; // 让块尾（=光标目标）落到视口外下方 ~60px
  ioEnter(t2);
  await sleep(1200); // CM 初始化
  if (!t2.querySelector(".cm-editor")) {
    fail("v3-init", { reason: "block 8 did not initialize" });
    return finish();
  }
  // 落 PM 选区到块尾（selectionToDOM → nodeView.setSelection → CM 光标置尾）
  view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, endPos)));
  await sleep(100);
  // 移走焦点：复现真实场景——用户点过代码块后焦点已他移，CM 未聚焦但光标保留在块尾
  if (document.activeElement && document.activeElement !== document.body) {
    document.activeElement.blur();
  }
  await sleep(100);
  const stPre = host.scrollTop;
  // 程序化内容写入（模拟 AI 流式 / 整篇回退落到该代码块）
  const tr = view.state.tr.insertText("  # ghost-probe", endPos);
  tr.setMeta("addToHistory", false);
  view.dispatch(tr);
  await sleep(500);
  const delta = Math.round((host.scrollTop - stPre) * 10) / 10;
  const v3 = delta === 0;
  v3 ? step("v3-no-ghost-write", { stPre, delta }) : fail("v3-no-ghost-write", { stPre, delta });

  finish();
}

function finish() {
  R.done = true;
  R.ts = new Date().toISOString();
  window.__scrollTest = { state: "done", result: R };
  say(`${R.ok ? "ALL PASS" : "FAIL"} — ${R.steps.length} steps`);
}

run().catch((e) => {
  fail("exception", { msg: String(e && e.stack ? e.stack : e) });
  finish();
});
