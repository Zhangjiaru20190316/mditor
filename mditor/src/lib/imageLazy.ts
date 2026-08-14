// Stamp `loading="lazy"` / `decoding="async"` onto the editor's image-block
// <img> elements (Crepe's Vue node view doesn't expose these as a config hook).
//
// ProseMirror renders the whole document (we deliberately do NOT virtualize the
// editor body — see the red lines), so in a long note with many embedded images
// every image decodes on open. `loading="lazy"` defers off-screen decodes and
// `decoding="async"` keeps image decode off the main thread.
//
// This is called from the editor's existing coalesced double-rAF "stamp" walk
// (the same cadence used for annotation markers), so it runs after doc changes
// without queuing a walk per keystroke. It is idempotent: it only writes an
// attribute when the element is missing it, so a settled DOM produces no writes
// (no extra style/layout invalidation, no MutationObserver feedback loop).

const IMG_SELECTOR = '.mditor-milkdown img[data-type="image-block"]';

/** Stamp lazy/async decode attrs on every editor image-block <img>. No-ops when
 *  no images are present or when they already carry the attrs. Safe any time. */
export function stampEditorImageLazyAttrs(): void {
  try {
    const imgs = document.querySelectorAll<HTMLImageElement>(IMG_SELECTOR);
    if (imgs.length === 0) return;
    imgs.forEach((img) => {
      if (img.getAttribute("loading") !== "lazy") img.setAttribute("loading", "lazy");
      if (img.getAttribute("decoding") !== "async") img.setAttribute("decoding", "async");
    });
  } catch {
    // DOM queries can race with editor teardown; never let this throw.
  }
}
