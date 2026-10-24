// blockPreMount（R11 E-a：块级主动预挂载，限速；R12 上滚冷块首挂+同步补偿）单测。
// 2026-10-20 拍板默认开启：未设 cfg 即生效；显式 {on:false} 为测量基线臂
// 语义（零行为）。开启后验证发现带、限速、视口内跳过与统计出口。
// R12：上滚冷块（mnt 未标）不再跳过——预挂 + 同步高度差补偿
// （premount-comp：scrollTop += 挂载前后高度差，同帧提交零可见窗口）。
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  __resetBlockPreMountForTest,
  setBlockPreMountEnabled,
} from "./blockPreMount";

interface FakeBlock {
  el: HTMLElement;
  pre: HTMLElement;
}

/** rect 桩：可热替换（trigger 模拟挂载后几何变化）。 */
function stubRect(el: HTMLElement, top: number, height: number): void {
  el.getBoundingClientRect = () =>
    ({ top, bottom: top + height, left: 0, right: 800, height, width: 800 }) as DOMRect;
}

function makeHost(docH = 20000): { host: HTMLElement; pm: HTMLElement } {
  const host = document.createElement("div");
  host.className = "mditor-editor-host";
  host.dataset.big = "";
  const pm = document.createElement("div");
  pm.className = "ProseMirror";
  host.appendChild(pm);
  document.body.appendChild(host);
  // jsdom 无真实布局：host/clientHeight 与 gBCR 全 0/固定——以显式桩驱动。
  stubRect(host, 0, 800);
  Object.defineProperty(host, "clientHeight", { value: 800, configurable: true });
  Object.defineProperty(host, "scrollHeight", { value: docH, configurable: true });
  return { host, pm };
}

function makeBlock(pm: HTMLElement, top: number, height: number, mounted = false): FakeBlock {
  const el = document.createElement("div");
  el.className = "milkdown-code-block";
  stubRect(el, top, height);
  const pre = document.createElement("pre");
  pre.className = "milkdown-code-block-placeholder";
  if (!mounted) el.appendChild(pre);
  pm.appendChild(el);
  return { el, pre };
}

function raf(): Promise<void> {
  return new Promise((resolve) => {
    const t = setInterval(() => {}, 0);
    setTimeout(() => {
      clearInterval(t);
      // jsdom rAF 走 16ms 定时器（vitest 环境），两帧余量。
      setTimeout(() => resolve(), 40);
    }, 40);
  });
}

describe("blockPreMount（默认开）", () => {
  beforeEach(() => {
    __resetBlockPreMountForTest();
    document.body.innerHTML = "";
    (window as unknown as Record<string, unknown>).__blockPreMountCfg = undefined;
    (window as unknown as Record<string, unknown>).__codeBlockPreMount = undefined;
  });
  afterEach(() => {
    __resetBlockPreMountForTest();
  });

  it("默认开启：未设 cfg 时预测带内占位块被预挂", async () => {
    const { pm } = makeHost();
    const inBand = makeBlock(pm, 900, 200); // 视口底(800)下方 100px——带内但非视口内
    const mounted = new Set<Element>();
    (window as unknown as Record<string, unknown>).__codeBlockPreMount = (el: Element) => {
      mounted.add(el);
      el.removeChild((el as HTMLElement).firstChild!);
      return true;
    };
    setBlockPreMountEnabled(true);
    window.dispatchEvent(new WheelEvent("wheel", { deltaY: 300 }));
    await raf();
    expect(mounted.has(inBand.el)).toBe(true);
  });

  it("显式关闭（{on:false}，测量基线臂语义）：wheel 后零触发", async () => {
    const { pm } = makeHost();
    makeBlock(pm, 1200, 200);
    const trigger = vi.fn(() => true);
    (window as unknown as Record<string, unknown>).__codeBlockPreMount = trigger;
    (window as unknown as Record<string, unknown>).__blockPreMountCfg = { on: false };
    setBlockPreMountEnabled(true);
    window.dispatchEvent(new WheelEvent("wheel", { deltaY: 300 }));
    await raf();
    expect(trigger).not.toHaveBeenCalled();
    const stats = (window as unknown as { __blockPreMountStats: () => { sweeps: number } }).__blockPreMountStats();
    expect(stats.sweeps).toBe(0);
  });

  it("开启后：预测带内占位块被预挂，视口内块跳过", async () => {
    const { pm } = makeHost();
    const inBand = makeBlock(pm, 900, 200); // 视口底(800)下方 100px——带内但非视口内
    const inViewport = makeBlock(pm, 400, 200); // 视口内——跳过
    const far = makeBlock(pm, 5000, 200); // 带外
    const mounted = new Set<Element>();
    (window as unknown as Record<string, unknown>).__codeBlockPreMount = (el: Element) => {
      mounted.add(el);
      el.removeChild((el as HTMLElement).firstChild!);
      return true;
    };
    (window as unknown as Record<string, unknown>).__blockPreMountCfg = { on: true, bandPx: 800, perFrame: 4 };
    setBlockPreMountEnabled(true);
    window.dispatchEvent(new WheelEvent("wheel", { deltaY: 300 }));
    await raf();
    expect(mounted.has(inBand.el)).toBe(true);
    expect(mounted.has(inViewport.el)).toBe(false);
    expect(mounted.has(far.el)).toBe(false);
  });

  it("限速：perFrame=1 时单帧只挂一块（下一帧续挂）", async () => {
    const { pm } = makeHost();
    const b1 = makeBlock(pm, 900, 100);
    const b2 = makeBlock(pm, 1100, 100);
    const order: Element[] = [];
    (window as unknown as Record<string, unknown>).__codeBlockPreMount = (el: Element) => {
      order.push(el);
      el.removeChild((el as HTMLElement).firstChild!);
      return true;
    };
    (window as unknown as Record<string, unknown>).__blockPreMountCfg = { on: true, bandPx: 800, perFrame: 1 };
    setBlockPreMountEnabled(true);
    window.dispatchEvent(new WheelEvent("wheel", { deltaY: 300 }));
    await raf();
    // 第一帧只有 b1；链式排程在后续帧挂 b2（40ms 余量 ≥2 帧）。
    expect(order.length).toBeGreaterThanOrEqual(1);
    expect(order[0]).toBe(b1.el);
    if (order.length >= 2) expect(order[1]).toBe(b2.el);
    expect(order.length).toBeLessThanOrEqual(2);
  });

  it("R12 上滚冷块首挂：预挂 + 高度差同步补偿（premount-comp）", async () => {
    const { host, pm } = makeHost();
    // 上滚带内（视口顶 0 以上 40px 外）：冷块（mnt 未标），占位高 70。
    const cold = makeBlock(pm, -500, 70);
    host.scrollTop = 5000;
    const mounted = new Set<Element>();
    (window as unknown as Record<string, unknown>).__codeBlockPreMount = (el: Element) => {
      mounted.add(el);
      el.removeChild((el as HTMLElement).firstChild!);
      // 模拟挂载后几何：高度 70 → 138（差 +68），top 不变（上方内容不动）。
      stubRect(el as HTMLElement, -500, 138);
      return true;
    };
    (window as unknown as Record<string, unknown>).__blockPreMountCfg = { on: true, bandPx: 800, perFrame: 4 };
    setBlockPreMountEnabled(true);
    window.dispatchEvent(new WheelEvent("wheel", { deltaY: -300 }));
    await raf();
    expect(mounted.has(cold.el)).toBe(true);
    // 同步补偿：scrollTop += 68（5000 → 5068），视口内容视觉零位移。
    expect(host.scrollTop).toBe(5068);
    const stats = (
      window as unknown as { __blockPreMountStats: () => { compCount: number; compSkippedDrift: number; compSkippedClamp: number } }
    ).__blockPreMountStats();
    expect(stats.compCount).toBe(1);
    expect(stats.compSkippedDrift).toBe(0);
    expect(stats.compSkippedClamp).toBe(0);
  });

  it("R12 上滚冷块首挂：曾挂载块（mnt=1）重挂零高度差不补偿", async () => {
    const { host, pm } = makeHost();
    const visited = makeBlock(pm, -500, 138);
    (visited.el as HTMLElement).dataset.mnt = "1"; // 曾挂载（teardown 冻结高在）
    host.scrollTop = 5000;
    const mounted = new Set<Element>();
    (window as unknown as Record<string, unknown>).__codeBlockPreMount = (el: Element) => {
      mounted.add(el);
      el.removeChild((el as HTMLElement).firstChild!);
      stubRect(el as HTMLElement, -500, 138); // 冻结高 = 真实高，无差
      return true;
    };
    (window as unknown as Record<string, unknown>).__blockPreMountCfg = { on: true, bandPx: 800, perFrame: 4 };
    setBlockPreMountEnabled(true);
    window.dispatchEvent(new WheelEvent("wheel", { deltaY: -300 }));
    await raf();
    expect(mounted.has(visited.el)).toBe(true);
    expect(host.scrollTop).toBe(5000);
    const stats = (
      window as unknown as { __blockPreMountStats: () => { compCount: number } }
    ).__blockPreMountStats();
    expect(stats.compCount).toBe(0);
  });

  it("R12 上滚冷块首挂防护：块顶漂移（几何异常）放弃补偿", async () => {
    const { host, pm } = makeHost();
    makeBlock(pm, -500, 70);
    host.scrollTop = 5000;
    (window as unknown as Record<string, unknown>).__codeBlockPreMount = (el: Element) => {
      el.removeChild((el as HTMLElement).firstChild!);
      // top 漂移 5px：挂载动了上方内容，补偿会放大错误——放弃。
      stubRect(el as HTMLElement, -495, 138);
      return true;
    };
    (window as unknown as Record<string, unknown>).__blockPreMountCfg = { on: true, bandPx: 800, perFrame: 4 };
    setBlockPreMountEnabled(true);
    window.dispatchEvent(new WheelEvent("wheel", { deltaY: -300 }));
    await raf();
    expect(host.scrollTop).toBe(5000);
    const stats = (
      window as unknown as { __blockPreMountStats: () => { compCount: number; compSkippedDrift: number } }
    ).__blockPreMountStats();
    expect(stats.compCount).toBe(0);
    expect(stats.compSkippedDrift).toBe(1);
  });

  it("R12 上滚冷块首挂防护：高度差超限（>PREMOUNT_COMP_MAX）放弃补偿", async () => {
    const { host, pm } = makeHost();
    makeBlock(pm, -500, 70);
    host.scrollTop = 5000;
    (window as unknown as Record<string, unknown>).__codeBlockPreMount = (el: Element) => {
      el.removeChild((el as HTMLElement).firstChild!);
      stubRect(el as HTMLElement, -500, 70 + 800); // 差 +800 > 400 上限
      return true;
    };
    (window as unknown as Record<string, unknown>).__blockPreMountCfg = { on: true, bandPx: 800, perFrame: 4 };
    setBlockPreMountEnabled(true);
    window.dispatchEvent(new WheelEvent("wheel", { deltaY: -300 }));
    await raf();
    expect(host.scrollTop).toBe(5000);
    const stats = (
      window as unknown as { __blockPreMountStats: () => { compCount: number; compSkippedClamp: number } }
    ).__blockPreMountStats();
    expect(stats.compCount).toBe(0);
    expect(stats.compSkippedClamp).toBe(1);
  });

  it("R12 上滚冷块首挂防护：补偿越滚动边界（贴顶）放弃", async () => {
    const { host, pm } = makeHost();
    makeBlock(pm, -500, 70);
    host.scrollTop = 10; // 贴顶：补偿 -68 后 <0
    (window as unknown as Record<string, unknown>).__codeBlockPreMount = (el: Element) => {
      el.removeChild((el as HTMLElement).firstChild!);
      stubRect(el as HTMLElement, -500, 70 - 68); // 差 -68（真实高 < 占位）
      return true;
    };
    (window as unknown as Record<string, unknown>).__blockPreMountCfg = { on: true, bandPx: 800, perFrame: 4 };
    setBlockPreMountEnabled(true);
    window.dispatchEvent(new WheelEvent("wheel", { deltaY: -300 }));
    await raf();
    expect(host.scrollTop).toBe(10);
    const stats = (
      window as unknown as { __blockPreMountStats: () => { compCount: number; compSkippedClamp: number } }
    ).__blockPreMountStats();
    expect(stats.compCount).toBe(0);
    expect(stats.compSkippedClamp).toBe(1);
  });

  it("R12 上滚冷块首挂：语言包迟到的高度定型由 recheck 帧补差", async () => {
    const { host, pm } = makeHost();
    makeBlock(pm, -500, 70);
    host.scrollTop = 5000;
    (window as unknown as Record<string, unknown>).__codeBlockPreMount = (el: Element) => {
      el.removeChild((el as HTMLElement).firstChild!);
      // 挂载同步完成时高度仍 70（纯文本中间态），30ms 后语言 reconfigure
      // 才把高度定型为 138（模拟动态 import 网络延迟）。
      stubRect(el as HTMLElement, -500, 70);
      setTimeout(() => stubRect(el as HTMLElement, -500, 138), 30);
      return true;
    };
    (window as unknown as Record<string, unknown>).__blockPreMountCfg = { on: true, bandPx: 800, perFrame: 4 };
    setBlockPreMountEnabled(true);
    window.dispatchEvent(new WheelEvent("wheel", { deltaY: -300 }));
    await raf();
    // 微任务段 dh=0 未补；recheck 帧发现 70→138 差并补上。
    expect(host.scrollTop).toBe(5068);
    const stats = (
      window as unknown as { __blockPreMountStats: () => { compCount: number } }
    ).__blockPreMountStats();
    expect(stats.compCount).toBe(1);
  });

  it("非 cv 档（无 data-big）不动作", async () => {
    const host = document.createElement("div");
    host.className = "mditor-editor-host"; // 无 data-big
    const pm = document.createElement("div");
    pm.className = "ProseMirror";
    host.appendChild(pm);
    document.body.appendChild(host);
    makeBlock(pm, 900, 200);
    const trigger = vi.fn(() => true);
    (window as unknown as Record<string, unknown>).__codeBlockPreMount = trigger;
    (window as unknown as Record<string, unknown>).__blockPreMountCfg = { on: true };
    setBlockPreMountEnabled(true);
    window.dispatchEvent(new WheelEvent("wheel", { deltaY: 300 }));
    await raf();
    expect(trigger).not.toHaveBeenCalled();
  });
});
