// blockPreMount（R11 E-a：块级主动预挂载，限速；R12 上滚冷块首挂+同步补偿；
// R13 输入全类型：scroll 驱动 / 跳落点例外 / idle 兜底 / 帧预算自适应限速）单测。
// 2026-10-20 拍板默认开启：未设 cfg 即生效；显式 {on:false} 为测量基线臂
// 语义（零行为）。开启后验证发现带、限速、视口内跳过与统计出口。
// R12：上滚冷块（mnt 未标）不再跳过——预挂 + 同步高度差补偿
// （premount-comp：scrollTop += 挂载前后高度差，同帧提交零可见窗口）。
// R13：滚动条拖拽/键滚/程序化滚动剖面由宿主 scroll 事件驱动同一条预测带
// 路径；单次大位移（≥max(480, 半视口)）走跳落点例外（视口内冷块当帧挂，
// "打开即渲染"口径）；无输入时 idle 轮询清 ±bandPx 双侧带；限速从
// perFrame=1 放宽为帧预算制（默认 ≥8ms 或 6 块即停，首块必挂）。
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
  const milk = document.createElement("div");
  milk.className = "mditor-milkdown"; // rich 面（richVisible 门：sv 模式 hidden）
  const pm = document.createElement("div");
  pm.className = "ProseMirror";
  milk.appendChild(pm);
  host.appendChild(milk);
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

/** 手动帧泵：接管 requestAnimationFrame，flush(n) 精确推进 n 帧（单帧断言用）。 */
function manualFrames(): { flush: (frames?: number) => void; restore: () => void } {
  const q: FrameRequestCallback[] = [];
  const orig = window.requestAnimationFrame;
  window.requestAnimationFrame = ((cb: FrameRequestCallback) => {
    q.push(cb);
    return q.length;
  }) as typeof requestAnimationFrame;
  return {
    flush(frames = 1) {
      for (let i = 0; i < frames; i++) {
        const cbs = q.splice(0);
        for (const cb of cbs) cb(performance.now());
      }
    },
    restore() {
      window.requestAnimationFrame = orig;
    },
  };
}

/** 宿主 scroll 事件派发（滚动条拖拽/键滚/程序化滚动的监听器剖面）。 */
function hostScroll(host: HTMLElement, to: number): void {
  host.scrollTop = to;
  host.dispatchEvent(new Event("scroll"));
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

  it("R13 全档武装：无 data-big 的宿主（默认档）同样预挂——档位门重审", async () => {
    const host = document.createElement("div");
    host.className = "mditor-editor-host"; // 无 data-big（默认档剖面）
    stubRect(host, 0, 800);
    const milk = document.createElement("div");
    milk.className = "mditor-milkdown";
    const pm = document.createElement("div");
    pm.className = "ProseMirror";
    milk.appendChild(pm);
    host.appendChild(milk);
    document.body.appendChild(host);
    const inBand = makeBlock(pm, 900, 200);
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
});

describe("blockPreMount R13（输入全类型预挂载）", () => {
  beforeEach(() => {
    __resetBlockPreMountForTest();
    document.body.innerHTML = "";
    (window as unknown as Record<string, unknown>).__blockPreMountCfg = undefined;
    (window as unknown as Record<string, unknown>).__codeBlockPreMount = undefined;
  });
  afterEach(() => {
    __resetBlockPreMountForTest();
  });

  it("scroll 驱动：宿主 scroll 事件（滚动条拖拽/键滚剖面）后带内占位块被预挂", async () => {
    const { host, pm } = makeHost();
    const inBand = makeBlock(pm, 900, 200);
    const mounted = new Set<Element>();
    (window as unknown as Record<string, unknown>).__codeBlockPreMount = (el: Element) => {
      mounted.add(el);
      el.removeChild((el as HTMLElement).firstChild!);
      return true;
    };
    setBlockPreMountEnabled(true);
    hostScroll(host, 0); // 首事件建差分基线
    hostScroll(host, 400); // 拖拽步进 400px：dir=down，带 [760, 800+800+400]
    await raf();
    expect(mounted.has(inBand.el)).toBe(true);
    const stats = (window as unknown as { __blockPreMountStats: () => { scrollMarks: number } })
      .__blockPreMountStats();
    expect(stats.scrollMarks).toBe(1);
  });

  it("scroll 驱动上滚：冷块首挂 + 同步高度差补偿（premount-comp，滚动条上拖剖面）", async () => {
    const { host, pm } = makeHost();
    makeBlock(pm, -500, 70); // 视口顶上方冷块，占位高 70
    (window as unknown as Record<string, unknown>).__codeBlockPreMount = (el: Element) => {
      el.removeChild((el as HTMLElement).firstChild!);
      stubRect(el as HTMLElement, -500, 138); // 挂载后 +68，top 不变
      return true;
    };
    host.scrollTop = 5000; // 开档位（enable 种子基线捕获）
    setBlockPreMountEnabled(true);
    hostScroll(host, 4700); // 上拖 -300：dir=up，带 [-1300, 40]
    await raf();
    expect(host.scrollTop).toBe(4768); // 4700 + 68：视口内容视觉零位移
    const stats = (
      window as unknown as { __blockPreMountStats: () => { compCount: number; scrollMarks: number } }
    ).__blockPreMountStats();
    expect(stats.compCount).toBe(1);
    expect(stats.scrollMarks).toBe(1);
  });

  it("自写补偿抑制：premount-comp 写入触发的 scroll 不驱动、不污染方向", async () => {
    const frames = manualFrames();
    try {
      const { host, pm } = makeHost();
      makeBlock(pm, -500, 70);
      (window as unknown as Record<string, unknown>).__codeBlockPreMount = (el: Element) => {
        el.removeChild((el as HTMLElement).firstChild!);
        stubRect(el as HTMLElement, -500, 138);
        return true;
      };
      host.scrollTop = 5000; // 开档位（enable 种子基线捕获）
      setBlockPreMountEnabled(true);
      hostScroll(host, 4700); // 上拖 -300：dir=up → 带内冷块首挂
      frames.flush(1); // sweep 帧（manualFrames 接管 rAF；landing rAF 一并跑）
      await Promise.resolve(); // 微任务：compensateUpMount 写入（登记 pendingSelfWrite）
      expect(host.scrollTop).toBe(4768); // 补偿已写入（4700 + 68）
      // 补偿写入本身会派发 scroll——模拟宿主把该事件送出：应被吞掉。
      host.dispatchEvent(new Event("scroll"));
      await Promise.resolve();
      let stats = (window as unknown as { __blockPreMountStats: () => { scrollMarks: number } })
        .__blockPreMountStats();
      expect(stats.scrollMarks).toBe(1); // 未增
      // 真实用户步进照常驱动。
      hostScroll(host, 4868);
      stats = (window as unknown as { __blockPreMountStats: () => { scrollMarks: number } })
        .__blockPreMountStats();
      expect(stats.scrollMarks).toBe(2);
    } finally {
      frames.restore();
    }
  });

  it("跳落点例外：大位移 scroll（≥max(480, 半视口)）→ 落点视口内冷块当帧挂", async () => {
    const frames = manualFrames();
    try {
      const { host, pm } = makeHost();
      const inVp = makeBlock(pm, 400, 200); // 落点视口内冷块
      const mounted = new Set<Element>();
      (window as unknown as Record<string, unknown>).__codeBlockPreMount = (el: Element) => {
        mounted.add(el);
        el.removeChild((el as HTMLElement).firstChild!);
        return true;
      };
      setBlockPreMountEnabled(true);
      hostScroll(host, 0); // 基线
      hostScroll(host, 8000); // End/目录跳转剖面：一步 +8000
      frames.flush(1); // 单帧：landing rAF 与 sweep rAF 都在本帧
      expect(mounted.has(inVp.el)).toBe(true);
      const stats = (
        window as unknown as {
          __blockPreMountStats: () => { landingRenders: number; landingMounted: number };
        }
      ).__blockPreMountStats();
      expect(stats.landingRenders).toBe(1);
      expect(stats.landingMounted).toBe(1);
    } finally {
      frames.restore();
    }
  });

  it("跳落点门槛：小位移 scroll（拖拽步进）不触发 landing", async () => {
    const { host, pm } = makeHost();
    makeBlock(pm, 400, 200); // 视口内冷块——landing 未触发时必须保持 IO 原路径
    const trigger = vi.fn(() => true);
    (window as unknown as Record<string, unknown>).__codeBlockPreMount = trigger;
    setBlockPreMountEnabled(true);
    hostScroll(host, 0);
    hostScroll(host, 120); // 步进 120 < 480：非跳转
    await raf();
    expect(trigger).not.toHaveBeenCalled(); // sweep 也不抢视口内块（抢修禁令）
    const stats = (
      window as unknown as { __blockPreMountStats: () => { landingRenders: number } }
    ).__blockPreMountStats();
    expect(stats.landingRenders).toBe(0);
  });

  it("idle 兜底：武装后无任何输入，±bandPx 双侧带内冷块被清（开档首滚窗）", async () => {
    const { host, pm } = makeHost();
    const below = makeBlock(pm, 900, 70);
    const above = makeBlock(pm, -500, 70);
    const mounted = new Set<Element>();
    (window as unknown as Record<string, unknown>).__codeBlockPreMount = (el: Element) => {
      mounted.add(el);
      el.removeChild((el as HTMLElement).firstChild!);
      stubRect(el as HTMLElement, el === above.el ? -500 : 900, 138);
      return true;
    };
    setBlockPreMountEnabled(true);
    // 无 wheel/touch/scroll：等 idle 轮询（300ms 起）跑至少一轮。
    await new Promise((r) => setTimeout(r, 500));
    expect(mounted.has(below.el)).toBe(true);
    expect(mounted.has(above.el)).toBe(true);
    const stats = (
      window as unknown as {
        __blockPreMountStats: () => { idleSweeps: number; idleMounted: number };
      }
    ).__blockPreMountStats();
    expect(stats.idleSweeps).toBeGreaterThanOrEqual(1);
    expect(stats.idleMounted).toBeGreaterThanOrEqual(2);
    // 上方冷块 idle 首挂同样走同步补偿：scrollTop 0 → 68。
    expect(host.scrollTop).toBe(68);
  });

  it("帧预算自适应：默认 cfg（无 perFrame）单帧可挂多块（快滚追平，H2）", async () => {
    const frames = manualFrames();
    try {
      const { pm } = makeHost();
      makeBlock(pm, 900, 100);
      makeBlock(pm, 1100, 100);
      const order: Element[] = [];
      (window as unknown as Record<string, unknown>).__codeBlockPreMount = (el: Element) => {
        order.push(el);
        el.removeChild((el as HTMLElement).firstChild!);
        return true;
      };
      setBlockPreMountEnabled(true);
      window.dispatchEvent(new WheelEvent("wheel", { deltaY: 300 }));
      frames.flush(1); // 单帧：两块都应挂完（trigger 快，预算 8ms 未尽、上限 6 未到）
      expect(order.length).toBe(2);
    } finally {
      frames.restore();
    }
  });

  it("cfg {on:false} 基线臂：scroll 驱动/landing/idle 全部零行为", async () => {
    const { host, pm } = makeHost();
    makeBlock(pm, 900, 200);
    makeBlock(pm, 400, 200);
    const trigger = vi.fn(() => true);
    (window as unknown as Record<string, unknown>).__codeBlockPreMount = trigger;
    (window as unknown as Record<string, unknown>).__blockPreMountCfg = { on: false };
    setBlockPreMountEnabled(true);
    hostScroll(host, 0);
    hostScroll(host, 400);
    hostScroll(host, 8000); // 大位移也不 landing
    await raf();
    expect(trigger).not.toHaveBeenCalled();
    const stats = (window as unknown as { __blockPreMountStats: () => { sweeps: number; landingRenders: number } })
      .__blockPreMountStats();
    expect(stats.sweeps).toBe(0);
    expect(stats.landingRenders).toBe(0);
  });

  it("sv 模式（.mditor-milkdown hidden，实例常驻）：sweep/idle 全不动作（隐藏块 churn 防护）", async () => {
    const { host, pm } = makeHost();
    (host.querySelector(".mditor-milkdown") as HTMLElement).hidden = true; // sv 剖面
    makeBlock(pm, 900, 200);
    const trigger = vi.fn(() => true);
    (window as unknown as Record<string, unknown>).__codeBlockPreMount = trigger;
    setBlockPreMountEnabled(true);
    window.dispatchEvent(new WheelEvent("wheel", { deltaY: 300 }));
    hostScroll(host, 0);
    hostScroll(host, 400);
    await raf();
    await new Promise((r) => setTimeout(r, 450)); // idle 轮询跑至少一轮
    expect(trigger).not.toHaveBeenCalled();
  });
});
