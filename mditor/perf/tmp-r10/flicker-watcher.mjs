// flicker-watcher.mjs —— R10 症状 S（滚动底部闪刷/换装可见）页内巡视器（共享模块）
// （一次性探针配套，历轮惯例随 commit 入库）
//
// 职责：每帧巡视编辑器滚动容器内「占位 ↔ 真身」换装状态，产出**换装可见
// 事件**（渲染/换装完成时刻元素已与视口相交的联合判定——S1 主口径，历轮
// 全部基准未覆盖的缺口口径）。
//
// 观测对象与三态：
//  - 行内公式 span.mditor-math-inline-lazy：lazy（源码占位）↔ ready（KaTeX 真身）
//  - 块级 div.milkdown-code-block（块公式 $$…$$ = LaTeX code_block 与普通代码块
//    共用 nodeview）：ph（占位 pre.milkdown-code-block-placeholder）→ mnt
//    （CodeMirror+Vue 已挂）→ done（.preview 内有 .katex——仅 LaTeX 块到达；
//    普通代码块 mnt 即终态：无 preview 可等）。
//
// 负载设计（不污染被测管线）：
//  - 注册期一次性 querySelectorAll 全量 + 探针 IO（root=host，rootMargin 1600px
//    ——应用侧 IO 800px 带外一倍，任何换装发生时元素必在关注集）；
//  - 滚动不增删元素（cv 档懒渲染只换状态），MutationObserver 仅兜底编辑/切档；
//  - 每帧只对关注集读状态（classList/firstElementChild O(1)，带内几百个），
//    仅状态变化的元素读一次 rect 判视口相交。
//
// 事件字段：{t, el, type: inline|block, kind, vis, bucket(0-9 十桶，-1 不可见),
//  reflash/remount/teardown/hdelta 标志, lang}。node 侧按 marks 分窗汇总
// （滚动驱动期 + 停滚 2s 窗 = S1 窗，§4 门禁表）。
//
// 红线：只读观测，不改任何 src/ 行为；探针负载自证（gaps p95 与 R9 基线同量级）。

// 页内巡视器本体（eval 注入）。注意：内层不用模板字符串（外层已用），
// 字符串拼接保持单层可读。
export const FLICKER_WATCHER = `(() => {
  const host = document.querySelector('.mditor-editor-host');
  const pm = host && host.querySelector('.ProseMirror');
  if (!host || !pm) return 'no-host';
  const st = {
    perf0: performance.now(),
    running: true, raf: 0, err: null, stopDone: false,
    watch: new Set(),
    els: new Map(),
    observed: new WeakSet(),
    events: [],
    tops: [], sh: [], gaps: [],
    snap: [],
    counts: { reg: 0, inlineFlip: 0, inlineDemote: 0, blockMount: 0, blockDone: 0, blockTeardown: 0, blockHdelta: 0 },
    blockStat: window.__blockMountStats ? { mounts: 0, teardowns: 0, remounts: 0 } : null,
  };
  window.__r10flicker = st;
  const hostTop = () => host.getBoundingClientRect().top;
  const bucketOf = (r, hTop) => {
    const rel = r.top - hTop;
    return Math.max(0, Math.min(9, Math.floor(((rel + r.height / 2) / host.clientHeight) * 10)));
  };
  const inlineState = (el) => el.classList.contains('mditor-math-inline-ready') ? 'ready' : 'lazy';
  const blockState = (el) => {
    const f = el.firstElementChild;
    if (f && f.tagName === 'PRE' && f.classList.contains('milkdown-code-block-placeholder')) return 'ph';
    if (el.querySelector('.preview-panel')) {
      return el.querySelector('.preview .katex') ? 'done' : 'mnt-latex';
    }
    return 'mnt-code';
  };
  const push = (el, rec, from, to, now, extra) => {
    const hTop = hostTop();
    const r = el.getBoundingClientRect();
    const vis = r.bottom > hTop && r.top < hTop + host.clientHeight;
    st.events.push(Object.assign({
      t: Math.round(now - st.perf0), el: rec.id, type: rec.type,
      lang: rec.lang, from, to, vis, bucket: vis ? bucketOf(r, hTop) : -1,
      lagMs: Math.round(now - (rec.watchedT ?? rec.seenT ?? now)),
    }, extra || {}));
  };
  // 状态完成度归一：mnt-latex 未完成（KaTeX 未出），mnt-code/done/ready 完成
  const io = new IntersectionObserver((es) => {
    for (const e of es) {
      if (e.isIntersecting) {
        st.watch.add(e.target);
        const rec = st.els.get(e.target);
        if (rec && rec.watchedT == null) rec.watchedT = Math.round(performance.now());
      } else st.watch.delete(e.target);
    }
  }, { root: host, rootMargin: '1600px 0px 1600px 0px' });
  let seq = 0;
  const reg = (el) => {
    if (st.observed.has(el) || !el.isConnected) return;
    st.observed.add(el);
    const isInline = el.classList.contains('mditor-math-inline-lazy');
    const rec = {
      id: (isInline ? 'i' : 'b') + (++seq), type: isInline ? 'inline' : 'block',
      lang: el.dataset.lang || '', state: isInline ? inlineState(el) : blockState(el),
      doneOnce: false, tearedOnce: false, demotedOnce: false, phH: 0,
      /** 占位态曾在视口内被观察到（S1 真闪判据：用户先看到占位、后换真身。
       *  同步渲染（wheel 事件内位移前完成）的元素占位从未在视口内 paint 过
       *  ——不计 S1，只记 paintInVis 供分析）。 */
      phSeenVis: false,
      seenT: Math.round(performance.now()),
    };
    st.els.set(el, rec);
    st.counts.reg++;
    io.observe(el);
    const hTop0 = hostTop();
    const r = el.getBoundingClientRect();
    if (r.bottom > hTop0 - 1700 && r.top < hTop0 + host.clientHeight + 1700) st.watch.add(el);
    if (rec.state === 'ph') rec.phH = Math.round(el.offsetHeight);
    // 安装时已在视口内的占位态（开档首屏）
    if (!isInline ? rec.state === 'ph' : rec.state === 'lazy') {
      if (r.bottom > hTop0 && r.top < hTop0 + host.clientHeight) rec.phSeenVis = true;
    }
  };
  for (const el of pm.querySelectorAll('.mditor-math-inline-lazy, .milkdown-code-block')) reg(el);
  const mo = new MutationObserver((muts) => {
    let needReg = [];
    for (const m of muts) {
      for (const n of m.addedNodes) {
        if (!(n instanceof Element)) continue;
        if (n.classList.contains('mditor-math-inline-lazy') || n.classList.contains('milkdown-code-block')) needReg.push(n);
        else if (n.querySelector) {
          for (const el of n.querySelectorAll('.mditor-math-inline-lazy, .milkdown-code-block')) needReg.push(el);
        }
      }
    }
    for (const el of needReg) reg(el);
  });
  mo.observe(pm, { childList: true, subtree: true });
  let last = 0, lastSnapAt = 0;
  const snapOnce = (now) => {
    try {
      const row = { t: Math.round(now - st.perf0) };
      if (typeof window.__mathPumpStats === 'function') row.pump = window.__mathPumpStats();
      const sd = window.__scrollDebug;
      if (sd) {
        const c = typeof sd.counters === 'function' ? sd.counters() : sd.counters;
        if (c) { const o = {}; for (const k of Object.keys(c)) { const v = c[k]; if (v && /^(demote|io\\.|cv\\.|prewarm\\.|anchor\\.|block\\.)/.test(k)) o[k] = v; } row.ctr = o; }
      }
      if (window.__blockMountStats) { const b = window.__blockMountStats; row.blk = { m: b.mounts, t: b.teardowns, r: b.remounts }; }
      st.snap.push(row);
    } catch (e) { /* 快照失败不致命 */ }
  };
  const tick = (now) => {
    if (!st.running) { st.stopDone = true; return; }
    try {
      if (last) st.gaps.push(Math.round(now - last));
      last = now;
      const t = Math.round(now - st.perf0);
      st.tops.push({ t, top: Math.round(host.scrollTop) });
      st.sh.push({ t, sh: host.scrollHeight });
      if (st.tops.length > 30000) { st.tops.splice(0, 10000); st.sh.splice(0, 10000); st.gaps.splice(0, 10000); }
      // 视口沿（本帧一次，供状态判定复用）
      const hTop = hostTop();
      const vh = host.clientHeight;
      for (const el of st.watch) {
        const rec = st.els.get(el);
        if (!rec || !el.isConnected) continue;
        const s = rec.type === 'inline' ? inlineState(el) : blockState(el);
        // 占位态视口内可见标记（每帧 tick 更新——S1 真闪判据：占位先被 paint）
        if ((rec.type === 'inline' && s === 'lazy') || (rec.type === 'block' && s === 'ph')) {
          if (!rec.phSeenVis) {
            const r = el.getBoundingClientRect();
            if (r.bottom > hTop && r.top < hTop + vh) rec.phSeenVis = true;
          }
        }
        if (s === rec.state) continue;
        const from = rec.state;
        rec.state = s;
        if (rec.type === 'inline') {
          if (from === 'lazy' && s === 'ready') {
            const reflash = rec.doneOnce || rec.demotedOnce;
            rec.doneOnce = true; rec.demotedOnce = false;
            st.counts.inlineFlip++;
            push(el, rec, from, s, now, { kind: 'inline-render', reflash: !!reflash, phSeenVis: rec.phSeenVis });
            rec.phSeenVis = false;
          } else if (from === 'ready' && s === 'lazy') {
            st.counts.inlineDemote++;
            rec.demotedOnce = true;
            push(el, rec, from, s, now, { kind: 'inline-demote' });
          }
        } else {
          if (from === 'ph' && s !== 'ph') {
            st.counts.blockMount++;
            push(el, rec, from, s, now, { kind: 'block-mount', remount: rec.tearedOnce, phSeenVis: rec.phSeenVis });
            rec.phSeenVis = false;
          } else if (from !== 'ph' && s === 'ph') {
            st.counts.blockTeardown++;
            rec.tearedOnce = true;
            push(el, rec, from, s, now, { kind: 'block-teardown' });
          } else if ((s === 'done' || s === 'mnt-code') && from !== s) {
            st.counts.blockDone++;
            const extra = { kind: 'block-done', remount: rec.tearedOnce, phSeenVis: rec.phSeenVis };
            if (rec.phH > 0) {
              const h1 = Math.round(el.offsetHeight);
              if (Math.abs(h1 - rec.phH) > 8) { st.counts.blockHdelta++; extra.hdelta = h1 - rec.phH; }
            }
            push(el, rec, from, s, now, extra);
            rec.phSeenVis = false;
          }
        }
      }
      if (now - lastSnapAt >= 250) { lastSnapAt = now; snapOnce(now); }
    } catch (e) { st.err = String(e); }
    st.raf = requestAnimationFrame(tick);
  };
  st.raf = requestAnimationFrame(tick);
  st.stop = () => {
    st.running = false;
    cancelAnimationFrame(st.raf);
    mo.disconnect(); io.disconnect();
    snapOnce(performance.now());
    return 'stopped';
  };
  return 'installed:' + st.counts.reg;
})()`;

// node 侧汇总：按 marks 分窗产出 S 组口径数字。
// marks: [{t,label}]（探针打点），窗定义：
//  - 每个滚动驱动段 [drive-begin, drive-end+400]（scrollPhase）
//  - S1 窗 = [drive-begin, drive-end+2400]（滚动驱动期 + 停滚 2s）
//  - quiet 窗 = [drive-end+400, drive-end+400+quietSecs*1000]（S3 sh 漂移 / M 组观测）
export function summarizeFlicker(flicker, marks, quietSecs) {
  const ev = flicker.events ?? [];
  const tops = flicker.tops ?? [];
  const sh = flicker.sh ?? [];
  const gaps = (flicker.gaps ?? []).filter((g) => g > 0 && g < 5000).sort((a, b) => a - b);
  const q = (p) => (gaps.length ? gaps[Math.floor(gaps.length * p)] : 0);
  const drives = [];
  let i = 0;
  while (i < marks.length) {
    if (marks[i].label.endsWith("-drive-begin")) {
      const seg = marks[i].label.slice(0, -"-drive-begin".length);
      let end = null;
      for (let j = i + 1; j < marks.length; j++) {
        if (marks[j].label === seg + "-drive-end") { end = marks[j].t; break; }
      }
      if (end != null) drives.push({ seg, begin: marks[i].t, end });
      i++;
    } else i++;
  }
  const inWin = (t, w) => t >= w[0] && t < w[1];
  // 事件分类：kind ∈ inline-render/block-mount/block-done/block-teardown/inline-demote
  // 块挂载可在单帧间隙完成整链（ph→done 一帧跳变，帧粒度巡视只见首尾）——
  // block-mount 事件 to=done/mnt-code 同样是"换装完成时刻"。
  // S1 真闪判据 = 完成于视口内（vis）且占位态曾在视口内被观察到（phSeenVis）
  // ——wheel 事件内位移前同步完成的换装（用户从未 paint 过占位态）不计。
  const isS1Done = (e) =>
    (e.kind === "inline-render" || e.kind === "block-done" ||
      (e.kind === "block-mount" && (e.to === "done" || e.to === "mnt-code"))) && e.vis && e.phSeenVis !== false;
  const isS1Fresh = (e) => isS1Done(e) && !e.reflash && !e.remount;
  const windows = drives.map((d) => {
    const s1win = [d.begin, d.end + 2400];
    const s1ev = ev.filter((e) => inWin(e.t, s1win));
    const byType = { inline: 0, blockMath: 0, blockCode: 0 };
    for (const e of s1ev) {
      if (!isS1Done(e)) continue;
      if (e.type === "inline") byType.inline++;
      else if (e.to === "done" || e.lang === "LaTeX" || e.from === "mnt-latex") byType.blockMath++;
      else byType.blockCode++;
    }
    const buckets = new Array(10).fill(0);
    for (const e of s1ev) if (isS1Done(e) && e.bucket >= 0) buckets[e.bucket]++;
    const quietStart = d.end + 400;
    const shQuiet = sh.filter((x) => x.t >= quietStart && x.t < quietStart + quietSecs * 1000);
    let shDrift = 0;
    for (let k = 1; k < shQuiet.length; k++) if (shQuiet[k].sh !== shQuiet[k - 1].sh) shDrift++;
    return {
      seg: d.seg, s1win,
      s1: {
        total: s1ev.filter(isS1Done).length, fresh: s1ev.filter(isS1Fresh).length,
        byType, buckets, bottom3: buckets[7] + buckets[8] + buckets[9],
      },
      s2: {
        reflash: s1ev.filter((e) => isS1Done(e) && (e.reflash || e.remount) && e.vis).length,
        teardownVis: s1ev.filter((e) => e.kind === "block-teardown" && e.vis).length,
        demoteVis: s1ev.filter((e) => e.kind === "inline-demote" && e.vis).length,
      },
      s3: {
        hdelta: s1ev.filter((e) => typeof e.hdelta === "number" && e.vis).length,
        shDriftFrames: shDrift,
      },
    };
  });
  const allS1 = windows.reduce((a, w) => a + w.s1.total, 0);
  const allS2 = windows.reduce((a, w) => a + w.s2.reflash, 0);
  const bucketsAll = new Array(10).fill(0);
  for (const w of windows) for (let b = 0; b < 10; b++) bucketsAll[b] += w.s1.buckets[b];
  return {
    counts: flicker.counts,
    frame: { n: gaps.length, p50: q(0.5), p95: q(0.95), max: gaps.length ? gaps[gaps.length - 1] : 0 },
    drives: windows,
    s1Total: allS1, s2Total: allS2,
    bucketsAll, bottom3All: bucketsAll[7] + bucketsAll[8] + bucketsAll[9],
    err: flicker.err ?? null,
  };
}
