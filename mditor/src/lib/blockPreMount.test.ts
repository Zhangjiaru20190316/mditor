// blockPreMount（R11 E-a：块级主动预挂载，限速）单测。
// 2026-10-20 拍板默认开启：未设 cfg 即生效；显式 {on:false} 为测量基线臂
// 语义（零行为）。开启后验证发现带、限速、上滚安全门、视口内跳过与统计出口。
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

function makeHost(docH = 20000): { host: HTMLElement; pm: HTMLElement } {
  const host = document.createElement("div");
  host.className = "mditor-editor-host";
  host.dataset.big = "";
  const pm = document.createElement("div");
  pm.className = "ProseMirror";
  host.appendChild(pm);
  document.body.appendChild(host);
  // jsdom 无真实布局：host/clientHeight 与 gBCR 全 0/固定——以显式桩驱动。
  host.getBoundingClientRect = () =>
    ({ top: 0, bottom: 800, left: 0, right: 800, height: 800, width: 800 }) as DOMRect;
  Object.defineProperty(host, "clientHeight", { value: 800, configurable: true });
  void docH;
  return { host, pm };
}

function makeBlock(pm: HTMLElement, top: number, height: number, mounted = false): FakeBlock {
  const el = document.createElement("div");
  el.className = "milkdown-code-block";
  el.getBoundingClientRect = () =>
    ({ top, bottom: top + height, left: 0, right: 800, height, width: 800 }) as DOMRect;
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

  it("上滚安全门：未挂载过的块跳过，曾挂载块放行", async () => {
    const { pm } = makeHost();
    const firstTime = makeBlock(pm, -1050, 200); // 上滚带内（lo=-1100），从未挂载
    const visited = makeBlock(pm, -800, 200);
    (visited.el as HTMLElement).dataset.mnt = "1"; // 曾挂载（teardown 冻结高在）
    const mounted = new Set<Element>();
    (window as unknown as Record<string, unknown>).__codeBlockPreMount = (el: Element) => {
      mounted.add(el);
      el.removeChild((el as HTMLElement).firstChild!);
      return true;
    };
    (window as unknown as Record<string, unknown>).__blockPreMountCfg = { on: true, bandPx: 800, perFrame: 4 };
    setBlockPreMountEnabled(true);
    window.dispatchEvent(new WheelEvent("wheel", { deltaY: -300 }));
    await raf();
    expect(mounted.has(visited.el)).toBe(true);
    expect(mounted.has(firstTime.el)).toBe(false);
    const stats = (window as unknown as { __blockPreMountStats: () => { skippedUp: number } }).__blockPreMountStats();
    expect(stats.skippedUp).toBe(1);
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
