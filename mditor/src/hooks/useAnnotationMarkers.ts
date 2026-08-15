// Stamp annotation markers onto Milkdown's rendered DOM.
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
// bail before any write when there are no annotation nodes, and only write an
// attribute when its value actually changes, to keep the DOM diff clean.)

import { useEffect } from "react";

const LABEL_NUM_RE = /^anno-(\d+)$/;

const HOST_SELECTOR = ".mditor-milkdown";
const DEF_SELECTOR = 'dl[data-type="footnote_definition"][data-label^="anno-"]';
const MARKER_SELECTOR =
  'sup[data-type="footnote_reference"][data-label^="anno-"]';

/** True if any annotation marker/definition exists in the rendered DOM, false
 *  when none do (callers can cache the "no annotations" verdict to skip later
 *  rounds — see useAnnotationMarkers). Safe to call any time; no-ops if the
 *  editor isn't mounted yet. Idempotent + early-exiting: only writes an
 *  attribute when its value actually changes. */
export function stampAnnotationMarkers(): boolean {
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
    return true;
  } catch {
    // DOM queries can race with editor teardown; never let this throw.
    return false;
  }
}

/** Cheap scan of MutationObserver records (NOT the tree): could these mutations
 *  have introduced or re-badged an annotation node? Used as the "resume now"
 *  signal when the last stamp found no annotations:
 *   * attributes — the observer's attributeFilter already limits these to
 *     data-label/data-type writes (the follow-up pass that badges a bare
 *     footnote <sup>/<dl> ProseMirror just created).
 *   * childList — any ADDED <sup>/<dl> element (footnote marker/definition
 *     containers; both are rare outside footnotes). Scoped to the added
 *     fragments, far cheaper than the full-tree queries in stamp above.
 *  Removals never matter here: this is only consulted when the document
 *  currently has no annotations, so there is nothing to remove. */
function recordsMayAffectAnnotations(records: MutationRecord[]): boolean {
  for (const r of records) {
    if (r.type === "attributes") return true;
    for (const n of r.addedNodes) {
      if (n.nodeType !== Node.ELEMENT_NODE) continue;
      const el = n as Element;
      if (el.tagName === "SUP" || el.tagName === "DL") return true;
      if (el.querySelector("sup, dl")) return true;
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
    // T4 早退缓存：上一轮 stamp 是否发现过注解节点。为 false 且本轮 mutation
    // 记录里也看不到任何 sup/dl/footnote 属性痕迹时，直接跳过这轮 DOM 查询
    // —— 无注解文档的每次键入不再触发两次全树查询。一旦注解节点/属性重新
    // 出现（或上一轮仍有注解），立即恢复完整 stamp 路径。
    let hadAnnotations = false;

    const run = () => {
      if (raf != null) cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        raf = null;
        hadAnnotations = stampAnnotationMarkers();
      });
    };

    const attach = (root: HTMLElement) => {
      run(); // initial stamp (also primes the hadAnnotations cache)
      observer = new MutationObserver((records) => {
        // T4: document currently has no annotations and these mutations can't
        // have created one — skip the debounced DOM-query round entirely.
        if (!hadAnnotations && !recordsMayAffectAnnotations(records)) return;
        // Debounce so a fast typist doesn't run a DOM walk on every keystroke.
        if (debounce) clearTimeout(debounce);
        debounce = setTimeout(run, 60);
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
    };
  }, [ready]);
}
