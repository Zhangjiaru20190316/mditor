// EX 轮阶段一：旧导出管线症状钉死（E-1/E-2 + RC-4 + RC-5 复现取证）。
// 前置：dev 实例已起（WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9223 npm run tauri dev），
//       fixture 已由 perf/gen-export-fixtures.mjs 生成。
// 用法：node perf/ex1-repro.mjs e1e2|rc4|rc5
// 产物：perf/results/ex-phase1-*.json / *.html / *.pdf
//
// 复现口径：全部走应用真实代码路径——__exportDebug.getHTML()（PM 模型序列
// 化）+ 页内 import 真模块（exportMath/exportSanitize/exporter/themeCss），
// 与 App.doExport → exportPdf 完全同源；唯一差异是不调用 win.print()（OS
// 对话框不可驱动），打印侧用 CDP Page.printToPDF（与「另存为 PDF」同一
// Chromium 打印引擎、同一分页语义）代替。
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { findPageTarget, Cdp, mouse, sleep } from "./cdp.mjs";

const section = process.argv[2] ?? "e1e2";
const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, "results");
mkdirSync(outDir, { recursive: true });
const FIX = "C:/Users/hh/Desktop/Tp/mditor/perf/fixtures";

const target = await findPageTarget(9223);
const cdp = await Cdp.connect(target.webSocketDebuggerUrl);
const m = mouse(cdp);

// fixture 目录递归授权（复刻用户工作区授权形态；open() 只授权了 .md 单文件，
// inlineLocalImages 读 assets/ 会被 fs scope 拒——那是测试基建问题不是症状）。
await cdp.eval(`(async () => {
  const { getAdapter } = await import('/src/platform/index.ts');
  await getAdapter().app.grantFsScope(['${FIX}'], true);
  return 'granted';
})()`);

async function openDoc(name, settleMs = 4000) {
  const ok = await cdp.eval(`window.__exportDebug.open("${FIX}/${name}")`);
  if (!ok) throw new Error("open failed: " + name);
  await sleep(settleMs);
}

/** 页内跑真实导出前段（renderBlockMath→sanitize→inline→wrap），返回 fullHtml+分图报告。 */
async function buildExportHtml(title) {
  return await cdp.eval(`(async () => {
    const raw = window.__exportDebug.getHTML();
    const docPath = window.__exportDebug.docPath();
    const { renderBlockMath } = await import('/src/lib/exportMath.ts');
    const { sanitizeExportHtml } = await import('/src/lib/exportSanitize.ts');
    const { inlineLocalImages, wrapHtml } = await import('/src/lib/exporter.ts');
    const { collectThemeCss } = await import('/src/lib/themeCss.ts');
    const math = renderBlockMath(raw);
    const safe = sanitizeExportHtml(math.html);
    const t0 = performance.now();
    const inlined = await inlineLocalImages(safe, docPath);
    const inlineMs = Math.round(performance.now() - t0);
    const srcs = (h) => [...h.matchAll(/<img\\b[^>]*\\bsrc="([^"]*)"/g)].map(x => x[1]);
    const before = srcs(safe), after = srcs(inlined);
    const imgs = before.map((s, i) => ({
      src: s.length > 90 ? s.slice(0, 87) + '…' : s,
      outcome: after[i] === s ? 'KEPT' : 'INLINED',
      inlinedKB: after[i] === s ? 0 : Math.round((after[i].length - s.length) * 3 / 4 / 1024),
    }));
    const theme = document.documentElement.getAttribute('data-theme') ?? 'light';
    const css = collectThemeCss();
    const full = wrapHtml(inlined, css, ${JSON.stringify(title)}, theme);
    return { rawKB: Math.round(raw.length / 1024), fullKB: Math.round(full.length / 1024),
            hasMath: math.hasMath, inlineMs, imgs, full, theme };
  })()`, { returnByValue: true });
}

// ---------------------------------------------------------------------------
if (section === "e1e2") {
  await openDoc("多图导出压测副本.md");
  const exp = await buildExportHtml("多图导出压测");
  // 把 wrapHtml 产物暂存到 window，供下一段 iframe 装载（避免巨串重复编码）。
  await cdp.eval(`window.__ex1Exp = ${JSON.stringify({ full: exp.full })}`);

  // 把 wrapHtml 产物装进 0×0 iframe（printHtml 同款），逐图跟踪就绪时间线。
  const tl = await cdp.eval(`(async () => {
    const exp = window.__ex1Exp;
    const iframe = document.createElement('iframe');
    iframe.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0';
    document.body.appendChild(iframe);
    const doc = iframe.contentDocument;
    doc.open(); doc.write(exp.full); doc.close();
    const t0 = performance.now();
    const events = [];
    const label = (img) => { const s = img.getAttribute('src') || ''; return s.startsWith('data:') ? s.slice(0, 44) : s; };
    const watch = () => {
      for (const img of doc.images) {
        if (img.dataset.__tracked) continue;
        img.dataset.__tracked = '1';
        if (img.complete && img.naturalWidth > 0) { events.push({ img: label(img), ev: 'complete@0ms' }); continue; }
        img.addEventListener('load', () => events.push({ img: label(img), ev: 'load@' + Math.round(performance.now() - t0) + 'ms', w: img.naturalWidth }), { once: true });
        img.addEventListener('error', () => events.push({ img: label(img), ev: 'error@' + Math.round(performance.now() - t0) + 'ms' }), { once: true });
      }
    };
    watch();
    const at = (ms) => new Promise(r => setTimeout(r, ms));
    await at(5300); // printHtml 的 5s 盲等 + 50ms 后即 print —— 此刻的状态就是进打印的
    watch();
    const snap = () => [...doc.images].map(img => ({ img: label(img), complete: img.complete, naturalWidth: img.naturalWidth }));
    const atPrint = snap();
    await at(8000); // 再等到网络图挂死/成功，佐证 5s 截断的后果
    const atEnd = snap();
    const fontsReady = await (doc.fonts?.ready.then(() => 'ready') ?? 'n/a');
    iframe.remove();
    // E-2：A4 打印版心宽度（100% 缩放、默认边距 1cm → 717px）下的溢出测量。
    const meas = document.createElement('iframe');
    meas.style.cssText = 'position:fixed;left:-20000px;top:0;width:717px;height:900px;border:0;background:#fff';
    document.body.appendChild(meas);
    const mdoc = meas.contentDocument;
    mdoc.open(); mdoc.write(exp.full); mdoc.close();
    await new Promise(r => setTimeout(r, 1200));
    const bw = mdoc.body.scrollWidth;
    const overflows = [...mdoc.body.querySelectorAll('table,pre,a,code,img,p,div')].map(el => {
      const rc = el.getBoundingClientRect();
      return { tag: el.tagName, cls: (el.className || '').toString().slice(0, 40),
               right: Math.round(rc.right), text: (el.textContent || '').trim().slice(0, 40) };
    }).filter(x => x.right > 718);
    const bodyStyle = mdoc.defaultView.getComputedStyle(mdoc.body);
    meas.remove();
    return { events, atPrint, atEnd, fontsReady, a4ContentWidthPx: 717,
             bodyScrollWidth: bw, bodyMaxWidth: bodyStyle.maxWidth,
             overflowCount: overflows.length, overflows: overflows.slice(0, 12) };
  })()`, { returnByValue: true });

  writeFileSync(join(outDir, "ex-phase1-e1e2.html"), exp.full);
  const report = {
    when: new Date().toISOString(),
    doc: "多图导出压测副本.md",
    pipeline: { rawKB: exp.rawKB, fullKB: exp.fullKB, hasMath: exp.hasMath, inlineMs: exp.inlineMs },
    images: exp.imgs,
    iframeTimeline: tl,
  };
  writeFileSync(join(outDir, "ex-phase1-e1e2.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
}

// ---------------------------------------------------------------------------
if (section === "rc4") {
  // RC-4：1MB 文档走打印管线（Page.printToPDF = OS 对话框「另存为 PDF」同
  // 引擎），量产物页数 vs 版心布局页数，观察截断/超时/缺尾。
  // 注意：23MB 级 HTML 绝不经 CDP returnByValue 回传（巨型 WS 帧会挂死连接）
  // ——全程 window.__rc4 页内暂存，只回传数字。
  await openDoc("一元微分学习题集_1MB压测副本.md", 9000);

  const sizes = await cdp.eval(`(async () => {
    window.__rc4 = { raw: window.__exportDebug.getHTML() };
    const { renderBlockMath } = await import('/src/lib/exportMath.ts');
    const t0 = performance.now();
    const math = renderBlockMath(window.__rc4.raw);
    const mathMs = Math.round(performance.now() - t0);
    const { sanitizeExportHtml } = await import('/src/lib/exportSanitize.ts');
    const t1 = performance.now();
    const safe = sanitizeExportHtml(math.html);
    const sanitizeMs = Math.round(performance.now() - t1);
    const { inlineLocalImages, wrapHtml } = await import('/src/lib/exporter.ts');
    const t2 = performance.now();
    const inlined = await inlineLocalImages(safe, window.__exportDebug.docPath());
    const inlineMs = Math.round(performance.now() - t2);
    const { collectThemeCss } = await import('/src/lib/themeCss.ts');
    const theme = document.documentElement.getAttribute('data-theme') ?? 'light';
    window.__rc4.full = wrapHtml(inlined, collectThemeCss(), '一元微分学习题集', theme);
    window.__rc4.raw = null;
    return { rawKB: Math.round(safe.length / 1024), fullKB: Math.round(window.__rc4.full.length / 1024),
             hasMath: math.hasMath, mathMs, sanitizeMs, inlineMs };
  })()`, { returnByValue: true });
  console.log("pipeline sizes:", JSON.stringify(sizes));

  // 版心高度下的期望页数（iframe 717px 宽布局，内容高 / 每页高）。
  const layout = await cdp.eval(`(async () => {
    const meas = document.createElement('iframe');
    meas.style.cssText = 'position:fixed;left:-20000px;top:0;width:717px;height:900px;border:0;background:#fff';
    document.body.appendChild(meas);
    const doc = meas.contentDocument;
    doc.open(); doc.write(window.__rc4.full); doc.close();
    await Promise.race([doc.fonts?.ready ?? Promise.resolve(), new Promise(r => setTimeout(r, 8000))]);
    await new Promise(r => setTimeout(r, 1500));
    const sw = doc.body.scrollWidth, sh = doc.documentElement.scrollHeight;
    const full = window.__rc4.full; // 快照供落盘
    meas.remove();
    return { scrollWidth: sw, scrollHeight: sh,
             // A4 11.69in - 2×1cm 边距 = 10.9in 版心高 @96dpi
             expectedPages: Math.ceil(sh / Math.round(10.9 * 96)), fullKB: Math.round(full.length / 1024) };
  })()`, { returnByValue: true });
  console.log("layout:", JSON.stringify(layout));

  // 落盘 wrapHtml 产物：页内分块读出（blob: URL 是页面源，Node fetch 不可达；
  // 单次 returnByValue 23MB 会挂 WS——1MB 块 × N 次安全）。
  const totalLen = await cdp.eval(`window.__rc4.full.length`, { returnByValue: true });
  const chunks = [];
  for (let i = 0; i < totalLen; i += 1_000_000) {
    chunks.push(await cdp.eval(
      `window.__rc4.full.slice(${i}, ${Math.min(i + 1_000_000, totalLen)})`,
      { returnByValue: true }
    ));
  }
  writeFileSync(join(outDir, "ex-phase1-rc4-1mb.html"), Buffer.from(chunks.join(""), "utf8"));

  // 独立 target 装同一 HTML → Page.printToPDF。window.open 无用户手势会被
  // WebView2 拦（POPUP_BLOCKED）——用 CDP Target.createTarget + vite @fs 直链
  // （HTML 已落盘于项目内，dev server 同源可服务，字体/CSS 相对解析不打折）。
  const auxUrl = `http://127.0.0.1:1420/@fs/C:/Users/hh/Desktop/Tp/mditor/perf/results/ex-phase1-rc4-1mb.html`;
  const created = await cdp.send("Target.createTarget", { url: auxUrl });
  await sleep(6000); // 23MB 文档装载 + 布局 + 字体

  const list = await (await fetch("http://127.0.0.1:9223/json")).json();
  const aux = list.find((t) => t.id === created.targetId);
  const result = { sizes, layout, auxFound: !!aux, auxUrl };
  if (aux) {
    const cdp2 = await Cdp.connect(aux.webSocketDebuggerUrl);
    await cdp2.send("Page.enable");
    const t0 = Date.now();
    try {
      const r = await cdp2.send("Page.printToPDF", {
        printBackground: true,
        paperWidth: 8.27, paperHeight: 11.69,
        marginTop: 0.394, marginBottom: 0.394, marginLeft: 0.394, marginRight: 0.394,
        scale: 1,
      });
      const buf = Buffer.from(r.data, "base64");
      writeFileSync(join(outDir, "ex-phase1-rc4-1mb.pdf"), buf);
      const latin = buf.toString("latin1");
      const pages = (latin.match(/\/Type\s*\/Page[^s]/g) || []).length;
      const countMatch = latin.match(/\/Count\s+(\d+)/);
      result.pdf = {
        bytes: buf.length, ms: Date.now() - t0,
        pageObjects: pages, countNode: countMatch ? Number(countMatch[1]) : null,
        truncatedVsLayout: (countMatch ? Number(countMatch[1]) : pages) < layout.expectedPages,
      };
    } catch (e) {
      result.pdf = { error: String(e).slice(0, 300), ms: Date.now() - t0 };
    }
    try { await cdp.send("Target.closeTarget", { targetId: created.targetId }); } catch { /* best-effort */ }
    cdp2.close();
  }
  await cdp.eval(`window.__rc4 = null`);
  writeFileSync(join(outDir, "ex-phase1-rc4.json"), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
}

// ---------------------------------------------------------------------------
if (section === "rc5") {
  // RC-5：减配档（总开关 ON + >3000 行）下公式序列化为源码。
  await openDoc("无穷级数_密度档压测副本_减配触发.md", 9000);

  const before = await cdp.eval(`(() => {
    const pm = document.querySelector('.ProseMirror');
    return {
      katexNodes: pm ? pm.querySelectorAll('.katex').length : -1,
      dollarTexts: pm ? (pm.textContent.match(/\\$/g) || []).length : -1,
      htmlDollars: (window.__exportDebug.getHTML().match(/\\$/g) || []).length,
      htmlKatex: (window.__exportDebug.getHTML().match(/katex/g) || []).length,
      htmlPreLatex: (window.__exportDebug.getHTML().match(/data-language="LaTeX"/g) || []).length,
    };
  })()`);

  // UI 驱动开总开关：帮助菜单 → 设置… → 性能与诊断 → 大文档性能模式 → 关闭。
  const menus = await cdp.eval(`JSON.stringify([...document.querySelectorAll('nav.mb [role=button],nav.mb button,[class*=mb-btn]')].map(b=>({t:b.textContent.trim(), r:(()=>{const x=b.getBoundingClientRect();return {x:Math.round(x.x+x.width/2),y:Math.round(x.y+x.height/2)}})()})))`);
  console.log("menus:", menus);

  const toggled = await cdp.eval(`(async () => {
    // 打开帮助菜单
    const btns = [...document.querySelectorAll('nav.mb button, nav.mb [role=button]')];
    const help = btns.find(b => b.textContent.trim() === '帮助');
    if (!help) return 'no-help-menu';
    help.click();
    await new Promise(r => setTimeout(r, 300));
    const item = [...document.querySelectorAll('div,button,a')].find(e => e.textContent.trim() === '设置…' && e.offsetParent !== null);
    if (!item) return 'no-settings-item';
    item.click();
    await new Promise(r => setTimeout(r, 500));
    // 分区 3 = 性能与诊断
    const navs = [...document.querySelectorAll('.settings-nav-btn')];
    if (!navs[3]) return 'no-nav-3:' + navs.map(n=>n.textContent).join(',');
    navs[3].click();
    await new Promise(r => setTimeout(r, 300));
    const boxes = [...document.querySelectorAll('.settings-pane input[type=checkbox]')];
    const perfToggle = boxes[0];
    if (!perfToggle) return 'no-checkbox';
    if (!perfToggle.checked) perfToggle.click();
    await new Promise(r => setTimeout(r, 400));
    // 应用 + 关闭（设置即存：onChange 走 set → saveSettings；关闭钮）
    const closeBtn = [...document.querySelectorAll('button')].find(b => /关闭|完成|完成/.test(b.textContent) && b.closest('.modal, [class*=modal]'));
    if (closeBtn) { closeBtn.click(); await new Promise(r => setTimeout(r, 400)); }
    return 'toggled:' + perfToggle.checked;
  })()`);
  console.log("toggle:", toggled);
  await sleep(6000); // 编辑器重建 + 重解析（25k 行）

  const after = await cdp.eval(`(() => {
    const pm = document.querySelector('.ProseMirror');
    const html = window.__exportDebug.getHTML();
    return {
      katexNodes: pm ? pm.querySelectorAll('.katex').length : -1,
      dollarTexts: pm ? (pm.textContent.match(/\\$/g) || []).length : -1,
      htmlDollars: (html.match(/\\$/g) || []).length,
      htmlKatex: (html.match(/katex/g) || []).length,
      htmlPreLatex: (html.match(/data-language="LaTeX"/g) || []).length,
    };
  })()`);

  // 导出前段跑一遍：renderBlockMath 后 $ 残留（PRE_RE 匹配不到行内源码形态）
  const exported = await cdp.eval(`(async () => {
    const raw = window.__exportDebug.getHTML();
    const { renderBlockMath } = await import('/src/lib/exportMath.ts');
    const r = renderBlockMath(raw);
    return { rawDollars: (raw.match(/\\$/g) || []).length,
             afterDollars: (r.html.match(/\\$/g) || []).length,
             afterKatex: (r.html.match(/katex/g) || []).length };
  })()`);

  // 还原：总开关拨回 OFF（不改变用户长期设置）。
  const restore = await cdp.eval(`(async () => {
    const btns = [...document.querySelectorAll('nav.mb button, nav.mb [role=button]')];
    const help = btns.find(b => b.textContent.trim() === '帮助');
    if (!help) return 'no-help';
    help.click();
    await new Promise(r => setTimeout(r, 300));
    const item = [...document.querySelectorAll('div,button,a')].find(e => e.textContent.trim() === '设置…' && e.offsetParent !== null);
    if (!item) return 'no-item';
    item.click();
    await new Promise(r => setTimeout(r, 500));
    const navs = [...document.querySelectorAll('.settings-nav-btn')];
    navs[3]?.click();
    await new Promise(r => setTimeout(r, 300));
    const perfToggle = [...document.querySelectorAll('.settings-pane input[type=checkbox]')][0];
    if (perfToggle?.checked) perfToggle.click();
    await new Promise(r => setTimeout(r, 400));
    const closeBtn = [...document.querySelectorAll('button')].find(b => /关闭|完成/.test(b.textContent) && b.closest('.modal, [class*=modal]'));
    closeBtn?.click();
    return perfToggle ? 'restored:' + !perfToggle.checked : 'no-toggle';
  })()`);
  console.log("restore:", restore);
  await sleep(5000);

  const report = { when: new Date().toISOString(), doc: "无穷级数_密度档压测副本_减配触发.md（3061 行 > BIG_DOC_LINES）", before, after, exported, restore };
  writeFileSync(join(outDir, "ex-phase1-rc5.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
}

cdp.close();
