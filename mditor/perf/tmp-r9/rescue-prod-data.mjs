// rescue-prod-data.mjs —— R9 一次性：救援 prod 探针挂死后页面内的采样数据
//（主探针 CDP 死链挂起时页面与 __r9focus 数据仍存活——新连接拉取分析+归位）
import { writeFileSync, readdirSync } from "node:fs";
import { spawnSync, execSync } from "node:child_process";
import { Cdp, sleep } from "../cdp.mjs";

const r = await fetch("http://127.0.0.1:9224/json");
const t = (await r.json()).find((x) => x.type === "page" && x.webSocketDebuggerUrl);
if (!t) { console.log("no page target"); process.exit(2); }
const cdp = await Cdp.connect(t.webSocketDebuggerUrl);
const withTimeout = (p, ms) => Promise.race([p, new Promise((res) => setTimeout(() => res(null), ms))]);

await withTimeout(cdp.eval(`window.__r9focus.stop = true`), 8000);
await sleep(1500);

const armLabels = await withTimeout(cdp.eval(`window.__r9focus ? window.__r9focus.marks.filter(m => m.label.endsWith("-switch-begin")).map(m => m.label.replace("-switch-begin","")) : []`), 8000);
if (!armLabels) { console.log("marks read timeout"); process.exit(2); }
const armMetas = armLabels.map((lab) => ({ i: Number(lab.split("-")[1]), mode: lab.split("-")[2] }));
console.log("arms:", JSON.stringify(armMetas));

const ANALYZE = `(() => {
  const armMetas = ${JSON.stringify(armMetas)};
  const rec = window.__r9focus;
  if (!rec) return { error: "no-rec" };
  const frames = rec.framesList ?? [];
  const marks = rec.marks ?? [];
  const findMark = (label) => { const hit = [...marks].reverse().find((x) => x.label === label); return hit ? hit.t : null; };
  const inWin = (t, w) => w && t >= w[0] && t < w[1];
  const quantile = (arr, q) => { if (!arr.length) return null; const a = [...arr].sort((x, y) => x - y); return Math.round(a[Math.min(a.length - 1, Math.floor(arr.length * q))] * 10) / 10; };
  const variance = (arr) => { if (!arr.length) return null; const mu = arr.reduce((s, x) => s + x, 0) / arr.length; return Math.round(arr.reduce((s, x) => s + (x - mu) * (x - mu), 0) / arr.length); };
  const arms = [];
  for (const meta of armMetas) {
    const lab = "arm-" + meta.i + "-" + meta.mode;
    const swB = findMark(lab + "-switch-begin"), swE = findMark(lab + "-settle-end");
    const dB = findMark(lab + "-drive-begin"), dE = findMark(lab + "-drive-end"), aE = findMark(lab + "-arm-end");
    if (swB == null || dB == null || dE == null || aE == null) { arms.push({ i: meta.i, mode: meta.mode, error: "marks-missing" }); continue; }
    const QUIET_GATE = 400;
    const switchWin = [swB, swE], scrollWin = [dB, dE + QUIET_GATE], quietWin = [dE + QUIET_GATE, aE];
    const scrollFrames = frames.filter((f) => inWin(f.t, scrollWin));
    const quietFrames = frames.filter((f) => inWin(f.t, quietWin));
    const swFrames = frames.filter((f) => inWin(f.t, switchWin));
    const scrollGaps = scrollFrames.map((f) => f.gap).filter((g) => g != null);
    const jankScroll = scrollFrames.filter((f) => f.gap > 32);
    const ltScroll = (rec.longtasks ?? []).filter((e) => inWin(e.t, scrollWin) || inWin(e.t + e.dur, scrollWin));
    const shiftScroll = [], shiftQuiet = [];
    let prevF = null;
    for (const f of frames) {
      if (prevF) {
        if (inWin(f.t, scrollWin)) {
          const stD = Math.round((f.st - prevF.st) * 10) / 10;
          for (const nm of ["top", "mid", "bot"]) {
            const a = prevF[nm], b = f[nm];
            if (a == null || b == null) continue;
            const d = Math.round((b - a) * 10) / 10;
            const residual = Math.round((d + stD) * 10) / 10;
            if (Math.abs(residual) > 4) { shiftScroll.push({ t: f.t, s: nm, d, stD, residual, gap: f.gap }); break; }
          }
        } else if (inWin(f.t, quietWin)) {
          for (const nm of ["top", "mid", "bot"]) {
            const a = prevF[nm], b = f[nm];
            if (a == null || b == null) continue;
            const d = Math.round((b - a) * 10) / 10;
            if (Math.abs(d) > 4) { shiftQuiet.push({ t: f.t, s: nm, d, st: f.st, gap: f.gap }); break; }
          }
        }
      }
      prevF = f;
    }
    const snapIn = (rec.snap ?? []).filter((x) => inWin(x.t, scrollWin) || inWin(x.t, quietWin));
    const ctrDelta = {};
    if (snapIn.length >= 2) {
      const a = snapIn[0].ctr ?? {}, b = snapIn[snapIn.length - 1].ctr ?? {};
      for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
        const d = (b[k] ?? 0) - (a[k] ?? 0);
        if (d) ctrDelta[k] = d;
      }
    }
    const shSeries = scrollFrames.map((f) => f.sh);
    const pwSeries = scrollFrames.map((f) => f.pw).filter((p) => p != null);
    arms.push({
      i: meta.i, mode: meta.mode,
      switchWin, scrollWin, quietWin,
      switch: { frames: swFrames.length, jank32: swFrames.filter((f) => f.gap > 32).length,
        gapMax: quantile(swFrames.map((f) => f.gap).filter((g) => g != null), 1) },
      scroll: { frames: scrollFrames.length, jank32: jankScroll.length,
        jank32Ratio: scrollFrames.length ? +(jankScroll.length / scrollFrames.length).toFixed(5) : null,
        gapP50: quantile(scrollGaps, 0.5), gapP95: quantile(scrollGaps, 0.95), gapMax: quantile(scrollGaps, 1),
        longtask50: ltScroll.length, ltDurSumMs: Math.round(ltScroll.reduce((s, e) => s + e.dur, 0)),
        shiftFrames: shiftScroll.length, shiftDetail: shiftScroll.slice(0, 20),
        shVar: variance(shSeries), shMin: shSeries.length ? Math.min(...shSeries) : null,
        shMax: shSeries.length ? Math.max(...shSeries) : null,
        pwStart: pwSeries[0] ?? null, pwEnd: pwSeries[pwSeries.length - 1] ?? null,
        mathUnreadyMax: null },
      quiet: { frames: quietFrames.length, jank32: quietFrames.filter((f) => f.gap > 32).length,
        gapP95: quantile(quietFrames.map((f) => f.gap).filter((g) => g != null), 0.95),
        longtask50: (rec.longtasks ?? []).filter((e) => inWin(e.t, quietWin)).length,
        driftShift: shiftQuiet.length, driftDetail: shiftQuiet.slice(0, 12),
        stStart: quietFrames[0]?.st ?? null, stEnd: quietFrames[quietFrames.length - 1]?.st ?? null },
      ctrDelta,
    });
  }
  const med = (arr) => { const a = arr.filter((x) => x != null).sort((x, y) => x - y); return a.length ? a[Math.floor(a.length / 2)] : null; };
  const pickArm = (mode, field) => arms.filter((x) => x.mode === mode && x.scroll && !x.error).map((x) => x.scroll[field]);
  const fJ = pickArm("focus", "jank32"), nJ = pickArm("normal", "jank32");
  const fP = pickArm("focus", "gapP95"), nP = pickArm("normal", "gapP95");
  return { arms, symmetry: {
    jank32Median: { focus: med(fJ), normal: med(nJ) },
    jank32Ratio: (med(nJ) ?? 0) > 0 ? +(med(fJ) / med(nJ)).toFixed(3) : (med(fJ) ? "inf(normal=0)" : 1),
    p95Median: { focus: med(fP), normal: med(nP) },
    p95Ratio: (med(nP) ?? 0) > 0 ? +(med(fP) / med(nP)).toFixed(3) : null,
    width: { focus: med(arms.filter((x) => x.mode === "focus" && x.scroll).map((x) => x.scroll.pwStart)),
      normal: med(arms.filter((x) => x.mode === "normal" && x.scroll).map((x) => x.scroll.pwStart)) } },
    totalFrames: frames.length, longtasksTotal: (rec.longtasks ?? []).length, marks };
})()`;

const analysis = await withTimeout(cdp.eval(ANALYZE), 30000);
if (!analysis) { console.log("ANALYZE TIMEOUT"); process.exit(2); }

const geo = await withTimeout(cdp.eval(`({ isFocus: document.querySelector(".app").classList.contains("is-focus") })`), 8000);
const events = await withTimeout(cdp.eval(`(() => { const sd = window.__scrollDebug; if (!sd) return []; const es = typeof sd.events === "function" ? sd.events() : sd.events; return (es ?? []).slice(-200).map(e => ({ ts: e.ts, kind: e.kind, msg: (e.msg || "").slice(0, 160) })); })()`), 20000);
const trap = await withTimeout(cdp.eval(`window.__scrollDebug && window.__scrollDebug.trap ? window.__scrollDebug.trap() : []`), 20000);
const pump = await withTimeout(cdp.eval(`typeof window.__mathPumpStats === "function" ? window.__mathPumpStats() : null`), 20000);

const row = { ts: new Date().toISOString(), tag: "r9p2p", run: 1, rescued: true, scenario: "down-slow",
  doc: "题型方法", ok: true, analysis, eventsInWindow: events ?? null, trap: trap ?? null, pumpEnd: pump ?? null };
const out = new URL("../../results/r9-phase2-prod-jank-abab-down-slow-other-r9p2p-1.json", import.meta.url).pathname.replace(/^\/([A-Z]:)/, "$1");
writeFileSync(out, JSON.stringify(row));
console.log("rescue 落盘:", out);
console.log("symmetry:", JSON.stringify(analysis.symmetry));

// focusMode 归位 + 关实例
if (geo && geo.isFocus) {
  for (const type of ["keyDown", "keyUp"]) {
    await cdp.send("Input.dispatchKeyEvent", { type, key: "Escape", code: "Escape", windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 }).catch(() => {});
  }
  await sleep(800);
}
cdp.close();
try {
  const net = execSync("netstat -ano").toString();
  for (const l of net.split("\n")) {
    if (/:9224\s.*LISTENING/i.test(l)) {
      const pid = l.trim().split(/\s+/).pop();
      if (/^\d+$/.test(pid)) spawnSync("taskkill", ["/F", "/T", "/PID", pid], { stdio: "ignore" });
    }
  }
} catch { /* */ }
process.exit(0);
