// Stamp `loading="lazy"` / `decoding="async"` (+ known aspect-ratio) onto the
// editor's image-block <img> elements (Crepe's Vue node view doesn't expose
// these as a config hook).
//
// ProseMirror renders the whole document (we deliberately do NOT virtualize the
// editor body — see the red lines), so in a long note with many embedded images
// every image decodes on open. `loading="lazy"` defers off-screen decodes and
// `decoding="async"` keeps image decode off the main thread.
//
// v3.9 — height reservation: once an image has loaded we record its natural
// size (session-wide cache keyed by src) and stamp `aspect-ratio` on every
// future render of the same src. Without it, an image loading mid-scroll grows
// from its placeholder height to the real height in one step → full-document
// reflow + scroll-anchor compensation = the "page jumps while scrolling"
// symptom on image-heavy notes. First view still shifts (dimensions unknown
// until decode), revisits/re-renders don't.
//
// This is called from the single merged DOM-stamp pass (useAnnotationMarkers)
// so it runs after doc changes without queuing a walk per keystroke. It is
// idempotent: it only writes an attribute when the element is missing it, so a
// settled DOM produces no writes (no extra style/layout invalidation, no
// MutationObserver feedback loop).

const IMG_SELECTOR = '.mditor-milkdown img[data-type="image-block"]';

/** src → natural {w,h} learned from completed loads this session. */
const knownSizes = new Map<string, { w: number; h: number }>();

/** Learn an image's intrinsic size (load listener in attachImageSizeLearning).
 * Exposed for tests. */
export function noteImageNaturalSize(src: string, w: number, h: number): void {
  if (!src || w <= 0 || h <= 0) return;
  if (knownSizes.has(src)) return; // first load wins; re-decodes give same值
  knownSizes.set(src, { w, h });
}

/** Cache lookup for tests. */
export function knownImageSize(src: string): { w: number; h: number } | undefined {
  return knownSizes.get(src);
}

/** Wire a capturing 'load' listener on the editor host so every image-block
 * <img> that finishes loading records its natural size (even ones the stamp
 * pass hasn't reached yet). Returns a detach function. */
export function attachImageSizeLearning(host: HTMLElement): () => void {
  const onLoad = (e: Event) => {
    const img = e.target as HTMLImageElement | null;
    if (!img || img.tagName !== "IMG") return;
    if (img.naturalWidth > 0 && img.naturalHeight > 0) {
      noteImageNaturalSize(img.getAttribute("src") ?? img.src, img.naturalWidth, img.naturalHeight);
    }
  };
  host.addEventListener("load", onLoad, true); // capture: images don't bubble
  return () => host.removeEventListener("load", onLoad, true);
}

/** Stamp lazy/async decode attrs (and cached aspect-ratio) on every editor
 * image-block <img>. Returns true when at least one image was seen (the
 * caller's early-exit cache keys off this). Safe any time. */
export function stampEditorImageLazyAttrs(): boolean {
  try {
    const imgs = document.querySelectorAll<HTMLImageElement>(IMG_SELECTOR);
    if (imgs.length === 0) return false;
    imgs.forEach((img) => {
      if (img.getAttribute("loading") !== "lazy") img.setAttribute("loading", "lazy");
      if (img.getAttribute("decoding") !== "async") img.setAttribute("decoding", "async");
      // Height reservation for already-known images: keeps layout stable
      // across re-renders (see file header). Unknown srcs are left alone —
      // a wrong ratio is worse than none.
      if (!img.style.aspectRatio) {
        const size = knownSizes.get(img.getAttribute("src") ?? img.src);
        if (size) img.style.aspectRatio = `${size.w} / ${size.h}`;
      }
    });
    return true;
  } catch {
    // DOM queries can race with editor teardown; never let this throw.
    return false;
  }
}
