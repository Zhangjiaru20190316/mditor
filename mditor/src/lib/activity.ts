// Global user-activity tracking (capture-phase, passive where possible).
//
// Consumers: the memory guard (defer heals while the user is typing/scrolling
// — recreating the editor mid-gesture is the "editor suddenly rebuilt while I
// was scrolling" complaint) and useMilkdown's idle history trim (same reason).
// Attach ONCE per page (main.tsx); reads are cheap Date.now() comparisons.

let lastInputAt = 0;
let lastScrollAt = 0;

/** Any input/keydown/pointer activity (typing, clicking, tabbing). */
export function noteUserInput(): void {
  lastInputAt = Date.now();
}

/** Wheel / scroll activity (reading a long document still counts as active). */
export function noteUserScroll(): void {
  lastScrollAt = Date.now();
}

/** Timestamp of the most recent user activity of either kind. */
export function lastActivityAt(): number {
  return Math.max(lastInputAt, lastScrollAt);
}

/** True when the user did something (input or scroll) within `windowMs`. */
export function isUserActive(windowMs: number): boolean {
  return Date.now() - lastActivityAt() < windowMs;
}

/** Wire the global listeners. Returns a detach function. Passive capture
 * listeners that only stamp a timestamp — no measurable overhead. */
export function attachActivityTracking(): () => void {
  const onInput = () => noteUserInput();
  const onScroll = () => noteUserScroll();
  window.addEventListener("input", onInput, true);
  window.addEventListener("keydown", onInput, true);
  window.addEventListener("pointerdown", onInput, true);
  window.addEventListener("wheel", onScroll, { capture: true, passive: true });
  window.addEventListener("scroll", onScroll, { capture: true, passive: true });
  return () => {
    window.removeEventListener("input", onInput, true);
    window.removeEventListener("keydown", onInput, true);
    window.removeEventListener("pointerdown", onInput, true);
    window.removeEventListener("wheel", onScroll, { capture: true });
    window.removeEventListener("scroll", onScroll, { capture: true });
  };
}
