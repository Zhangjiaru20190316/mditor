// Stamp annotation markers onto Milkdown's rendered DOM — the single merged
// "DOM stamp pass" for the editor surface.
//
// Milkdown (gfm preset) renders `[^anno-N]` as
//   <sup data-type="footnote_reference" data-label="anno-N">anno-N</sup>
// and gathers the definitions into
//   <dl data-type="footnote_definition" data-label="anno-N"><dt>anno-N</dt><dd>…</dd></dl>
//
// annotation.css needs a machine-readable flag that says "this is an annotation,
// not a normal footnote" so it can (a) restyle the marker as a numbered badge
// and (b) hide the definition block. CSS cannot parse the number out of the
// "anno-N" label, so after every render we stamp:
//   * markers → data-anno-num="<N>"   (CSS draws the badge from this via ::before)
//   * defs    → data-anno             (CSS hides these)
//
// We attach a MutationObserver on the editor host so this runs after every
// change (typing, setValue, mode switch, file open) without each call site
// needing to remember to invoke us. (Milkdown, unlike Vditor, has no GopherJS
// parse loop to feed, so the observer feedback concern is moot — but we still
// bail before any write when there is nothing to stamp, and only write an
// attribute when its value actually changes, to keep the DOM diff clean.)
//
// v3.9 — merged pass: the image lazy/aspect-ratio stamp (lib/imageLazy) and
// the code-line highlight restore (lib/codeAnno) ride the SAME debounced
// observer callback, and useMilkdown no longer schedules its own duplicate
// double-rAF walk per markdownUpdated event. One observer, one debounce, one
// rAF → three concerns, paid once per change instead of three times.

import { useEffect } from "react";
import { stampEditorImageLazyAttrs, attachImageSizeLearning } from "../lib/imageLazy";
import { restoreCodeLineHighlights } from "../lib/codeAnno";
import { annoCount, withPmObserverPaused } from "../lib/annoDebug";

const LABEL_NUM_RE = /^anno-(\d+)$/;

/** 防抖窗口：mutation 停歇 60ms 后执行一轮 stamp。 */
const STAMP_DEBOUNCE_MS = 60;
/** 强制执行上限：连续 mutation（AI 批注流式每帧替换定义节点）会不断重置
 *  防抖 timer，让 stamp 无限推迟 —— 流式期间徽章停留在无编号/块级中间态，
 *  结束才整体「咔哒」跳一次。距上次实际执行超过 250ms 就强制跑一轮。 */
const STAMP_MAX_WAIT_MS = 250;

const HOST_SELECTOR = ".mditor-milkdown";
const DEF_SELECTOR = 'dl[data-type="footnote_definition"][data-label^="anno-"]';
const MARKER_SELECTOR =
  'sup[data-type="footnote_reference"][data-label^="anno-"]';
/** Class stamped on marker-only paragraphs — see stampMarkerRows. */
const ROW_CLASS = "anno-row-item";

/** True when the paragraph holds nothing but annotation markers (plus
 *  whitespace) — i.e. it's one of the per-marker paragraphs dropped after a
 *  code block, not a prose paragraph a marker happens to live in.
 *  ProseMirror pads atom-only paragraphs with layout helpers — a separator
 *  <img> between inline atoms and a trailing <br> — which must not disqualify
 *  the paragraph (they are in every marker paragraph the real editor
 *  renders). */
function isMarkerOnlyParagraph(p: Element): boolean {
  return Array.from(p.childNodes).every((n) => {
    if (n.nodeType === Node.TEXT_NODE) return n.textContent?.trim() === "";
    if (!(n instanceof Element)) return false;
    if (n.tagName === "BR") return true;
    if (n.tagName === "IMG" && n.classList.contains("ProseMirror-separator")) {
      return true;
    }
    return n.matches(MARKER_SELECTOR);
  });
}

/**
 * Stamp `anno-row-item` on marker-only paragraphs. Code-block annotations
 * each get their own paragraph below the block (code_block can't hold an
 * inline footnote_reference), and block-level paragraphs stack vertically —
 * one ~48px line per badge. annotation.css turns these paragraphs
 * display:inline so consecutive ones flow into a single horizontal row that
 * wraps when full. Render-layer only: the class is not in the schema (never
 * serialized back to markdown) and the source text keeps one marker per
 * line, which resolveCodeLines' block-anchor heuristic depends on.
 */
function stampMarkerRows(): void {
  const paras = new Set<Element>();
  document.querySelectorAll<HTMLElement>(MARKER_SELECTOR).forEach((el) => {
    const p = el.closest("p");
    if (p) paras.add(p);
  });
  // Also revisit previously-stamped paragraphs: a marker may have been
  // deleted or text typed into one, disqualifying it.
  document.querySelectorAll(`p.${ROW_CLASS}`).forEach((p) => paras.add(p));
  paras.forEach((p) => p.classList.toggle(ROW_CLASS, isMarkerOnlyParagraph(p)));
}

/** True if any annotation marker/definition exists in the rendered DOM, false
 *  when none do (callers can cache the "no annotations" verdict to skip later
 *  rounds — see useAnnotationMarkers). Safe to call any time; no-ops if the
 *  editor isn't mounted yet. Idempotent + early-exiting: only writes an
 *  attribute when its value actually changes.
 *
 *  v3.9.3：全程包在 PM 观察器暂停窗口内（annoDebug.withPmObserverPaused）。
 *  对 PM 管辖 DOM 的任何属性/class 写入都会被 ProseMirror 的 DOMObserver
 *  当作外来突变而触发防御性重渲染（从 toDOM 重建节点、抹掉写入），我们的
 *  MO 又会把重建当成新一轮盖章信号——实测 60ms 防抖周期 17Hz 死循环
 *  （徽章无编号/悬停闪烁/marker 段落振荡之源）。暂停窗口内写入不产生
 *  MutationRecord，PM 看不见，循环无从起。 */
export function stampAnnotationMarkers(): boolean {
  let ok = false;
  withPmObserverPaused(() => {
    ok = stampMarkersNow();
  });
  return ok;
}

function stampMarkersNow(): boolean {
  try {
    // Early-exit when no annotation nodes exist — avoids touching the DOM.
    if (
      !document.querySelector(DEF_SELECTOR) &&
      !document.querySelector(MARKER_SELECTOR)
    ) {
      return false;
    }

    // Definition blocks are hidden purely by CSS on the stable [data-label]
    // prefix (see annotation.css) — we do NOT stamp them, because ProseMirror
    // re-renders the footnote_definition block and would wipe any attribute we
    // set on it. The marker below is an inline atom node whose attributes DO
    // persist, so we stamp its badge number there.
    // Markers: extract the number from data-label for the badge.
    document.querySelectorAll<HTMLElement>(MARKER_SELECTOR).forEach((el) => {
      const label = el.getAttribute("data-label") ?? "";
      const m = label.match(LABEL_NUM_RE);
      if (m && el.getAttribute("data-anno-num") !== m[1]) {
        el.setAttribute("data-anno-num", m[1]);
      }
    });
    // Marker-only paragraphs become horizontal wrap rows (see stampMarkerRows).
    stampMarkerRows();
    return true;
  } catch {
    // DOM queries can race with editor teardown; never let this throw.
    return false;
  }
}

/** Cheap scan of MutationObserver records (NOT the tree): could these mutations
 *  have introduced something the merged stamp pass needs to look at? Used as
 *  the "resume now" signal when the last pass found nothing to stamp:
 *   * attributes — the observer's attributeFilter already limits these to
 *     data-label/data-type writes (the follow-up pass that badges a bare
 *     footnote <sup>/<dl> ProseMirror just created).
 *   * childList — any ADDED <sup>/<dl>/<img> element (footnote marker/def
 *     containers and image blocks; all rare outside their features). Scoped
 *     to the added fragments, far cheaper than the full-tree queries in the
 *     stamp above.
 *  Removals never matter here: this is only consulted when the document
 *  currently has nothing to stamp, so there is nothing to remove. */
function recordsMayAffectStamps(records: MutationRecord[]): boolean {
  for (const r of records) {
    if (r.type === "attributes") return true;
    for (const n of r.addedNodes) {
      if (n.nodeType !== Node.ELEMENT_NODE) continue;
      const el = n as Element;
      if (el.tagName === "SUP" || el.tagName === "DL" || el.tagName === "IMG") {
        return true;
      }
      if (el.querySelector("sup, dl, img")) return true;
    }
  }
  return false;
}

/**
 * Keep annotation markers stamped after every DOM change inside the editor.
 * Pass the editor's `ready` flag so we only attach once Milkdown exists.
 */
export function useAnnotationMarkers(ready: boolean): void {
  useEffect(() => {
    if (!ready) return;
    let cancelled = false;
    let raf: number | null = null;
    let debounce: ReturnType<typeof setTimeout> | null = null;
    let observer: MutationObserver | null = null;
    let detachSizeLearning: (() => void) | null = null;
    // T4 早退缓存：上一轮 pass 是否发现过需要处理的节点（批注或图片）。
    // 为 false 且本轮 mutation 记录里也看不到任何 sup/dl/img 痕迹时，直接
    // 跳过这轮 DOM 查询 —— 无注解无图片文档的每次键入不再触发全树查询。
    // 一旦节点重新出现（或上一轮仍有），立即恢复完整 stamp 路径。
    let hadStamps = false;
    // 上次 stamp 实际执行的时刻（maxWait 判定用；run 的 rAF 回调里更新）。
    let lastRun = 0;

    const run = () => {
      if (raf != null) cancelAnimationFrame(raf);
        raf = requestAnimationFrame(() => {
          raf = null;
          lastRun = Date.now();
          // 合并的单通道 stamp：批注徽章 | 图片懒加载/宽高 | 高亮补画。
          // 全部在 PM 观察器暂停窗口内执行（图片属性/行内 class 同样是
          // 写 PM 管辖的 DOM，见 stampAnnotationMarkers 的战争说明）。
          let hadAnnos = false;
          let hadImgs = false;
          withPmObserverPaused(() => {
            hadAnnos = stampAnnotationMarkers();
            hadImgs = stampEditorImageLazyAttrs();
            restoreCodeLineHighlights();
          });
          hadStamps = hadAnnos || hadImgs;
          // 诊断：盖章轮次计数（流式/重建期间频率一眼可见；noop = 早退）。
          annoCount(hadStamps ? "stamp.pass" : "stamp.noop");
        });
    };

    /** 防抖 + maxWait：新 mutation 到来时按剩余预算重排；距上次执行已超过
     *  STAMP_MAX_WAIT_MS 则立即执行（防流式期间的饥饿）。 */
    const schedule = () => {
      const remaining = STAMP_MAX_WAIT_MS - (Date.now() - lastRun);
      const wait = Math.max(0, Math.min(STAMP_DEBOUNCE_MS, remaining));
      if (debounce) clearTimeout(debounce);
      if (wait === 0) {
        run();
        return;
      }
      debounce = setTimeout(() => {
        debounce = null;
        run();
      }, wait);
    };

    const attach = (root: HTMLElement) => {
      run(); // initial stamp (also primes the hadStamps cache)
      detachSizeLearning = attachImageSizeLearning(root);
      observer = new MutationObserver((records) => {
        // Debounce so a fast typist doesn't run a DOM walk on every keystroke;
        // maxWait keeps a continuous mutation stream (AI streaming) fed.
        if (!hadStamps && !recordsMayAffectStamps(records)) return;
        schedule();
      });
      // childList+subtree (no characterData): annotation markers/defs are
      // element nodes added/removed via childList. We ALSO watch the handful of
      // attributes Milkdown populates on footnote nodes: ProseMirror creates the
      // <dl>/<sup> first, then sets data-label/data-type in a follow-up
      // decoration pass — without `attributes` those attribute writes don't
      // re-trigger the stamp and the definition block would never get badged/hidden.
      observer.observe(root, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ["data-label", "data-type"],
      });
    };

    // The host exists by the time `ready` flips true, but be defensive: poll a
    // couple of times if the flag raced ahead of the DOM.
    let tries = 0;
    const find = () => {
      if (cancelled) return;
      const root = document.querySelector<HTMLElement>(HOST_SELECTOR);
      if (root) {
        attach(root);
      } else if (tries++ < 20) {
        debounce = setTimeout(find, 100);
      }
    };
    find();

    return () => {
      cancelled = true;
      if (raf != null) cancelAnimationFrame(raf);
      if (debounce) clearTimeout(debounce);
      observer?.disconnect();
      observer = null;
      detachSizeLearning?.();
      detachSizeLearning = null;
    };
  }, [ready]);
}
