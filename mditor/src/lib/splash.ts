// 开屏动画的淡出控制。开屏本身是 index.html 里的静态 HTML/CSS（见其中的
// <style> 注释），在 JS bundle 加载期间即已绘制；本模块只在 App 就绪后把
// 它淡出移除，因此正常启动下开屏时长 == 原本的白屏时长，不多等一毫秒。

/** 最短可见时长（ms）。仅当启动快于此值时才补足等待——否则热启动下动画
 *  只闪现一两百毫秒，观感接近故障而非开屏。 */
const SPLASH_MIN_MS = 450;

/** 淡出时长（ms），与 index.html 里 #splash 的 transition 保持一致。 */
const SPLASH_FADE_MS = 240;

let dismissed = false;

/** 幂等。补足剩余的最短可见时长后加 .is-done 触发淡出，过渡结束再移除节点。 */
export function dismissSplash(): void {
  if (dismissed) return;
  dismissed = true;
  const el = document.getElementById("splash");
  if (!el) return;
  // performance.now() 从导航起点（timeOrigin）起算，恰好等于开屏已显示的时长
  const remaining = Math.max(0, SPLASH_MIN_MS - performance.now());
  window.setTimeout(() => {
    el.classList.add("is-done");
    window.setTimeout(() => el.remove(), SPLASH_FADE_MS + 60);
  }, remaining);
}
