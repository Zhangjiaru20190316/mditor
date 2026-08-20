// placeCard 纯几何摆位的行为锁定（v3.9.1 从 AnnotationPopover 抽出）。
// 关键契约：
//  * 常规布局下按 右/左/右下/左下 候选顺序紧贴锚点，不压其他徽章；
//  * 兜底钳位（所有候选失败时）绝不盖住被点击的锚点徽章自身——被盖住的
//    徽章在弹层打开期间不可点击，下一击落在卡片上被 contains 守卫吞掉，
//    正是「经常要点两次」的形态之一。兜底允许压到*其他*徽章（全被堵死时
//    无处可放，与旧行为一致），但锚点必须让开。
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { clampTop, placeCard, type PlaceBox } from "./popoverPlace";

// node 测试环境没有 window —— placeCard 只读 innerWidth/innerHeight，
// 桩一个最小 window 即可（不引 jsdom）。
const windowStub = { innerWidth: 1280, innerHeight: 800 };
(globalThis as Record<string, unknown>).window = windowStub;

const setViewport = (w: number, h: number) => {
  windowStub.innerWidth = w;
  windowStub.innerHeight = h;
};

beforeEach(() => {
  setViewport(1280, 800);
});

afterEach(() => {
  setViewport(1280, 800);
});

const box = (left: number, top: number, w: number, h: number): PlaceBox => ({
  left,
  right: left + w,
  top,
  bottom: top + h,
});

const CARD = { w: 304, h: 160 };
// 徽章尺寸（annotation.css：16px 药丸）。
const BADGE = { w: 20, h: 20 };

const overlaps = (p: { left: number; top: number }, t: PlaceBox) =>
  p.left < t.right + 4 &&
  p.left + CARD.w > t.left - 4 &&
  p.top < t.bottom + 4 &&
  p.top + CARD.h > t.top - 4;

describe("placeCard 候选选择", () => {
  it("默认放锚点右侧、顶对齐", () => {
    const anchor = box(400, 300, BADGE.w, BADGE.h);
    const p = placeCard(anchor, [], CARD);
    expect(p.left).toBe(anchor.right + 8);
    expect(p.top).toBe(anchor.top);
  });

  it("右侧放不下（贴视口右缘）→ 放左侧", () => {
    const anchor = box(1240, 300, BADGE.w, BADGE.h);
    const p = placeCard(anchor, [], CARD);
    expect(p.left + CARD.w).toBe(anchor.left - 8);
    expect(p.top).toBe(anchor.top);
  });

  it("右侧通道被其他徽章占 → 跳到下方候选而不是压徽章", () => {
    const anchor = box(100, 300, BADGE.w, BADGE.h);
    const blocker = box(140, 290, BADGE.w, BADGE.h); // 右侧通道；左侧出屏
    const p = placeCard(anchor, [blocker], CARD);
    expect(p.left).toBe(anchor.right + 8);
    expect(p.top).toBe(anchor.bottom + 8);
    expect(overlaps(p, blocker)).toBe(false);
  });
});

describe("placeCard 锚点自避让（「要点两次」修复）", () => {
  it("窄视口兜底钳位横跨锚点时 → 挪到锚点下方", () => {
    setViewport(340, 800); // 卡片 304px 放不进锚点两侧 → 兜底钳到左缘
    const anchor = box(10, 300, BADGE.w, BADGE.h);
    const p = placeCard(anchor, [], CARD);
    expect(overlaps(p, anchor)).toBe(false);
    expect(p.top).toBe(anchor.bottom + 8);
  });

  it("下方也放不下（锚点贴底）→ 挪到锚点上方", () => {
    setViewport(400, 800); // 两侧仍放不下；锚点 y=700 使钳位 top 与锚点重叠
    const anchor = box(150, 700, BADGE.w, BADGE.h);
    const p = placeCard(anchor, [], CARD);
    expect(overlaps(p, anchor)).toBe(false);
    expect(p.top + CARD.h).toBeLessThanOrEqual(anchor.top - 8 + 4); // 卡片底贴锚点上方
  });

  it("常规候选不会因锚点自身在避让集里被误拒（右侧候选照常命中）", () => {
    const anchor = box(400, 300, BADGE.w, BADGE.h);
    const p = placeCard(anchor, [], CARD);
    expect(p.left).toBe(anchor.right + 8);
  });
});

describe("placeCard 密集徽章行", () => {
  it("四周全被占的兜底结果：可压其他徽章（无处可放），但绝不盖锚点且在视口内", () => {
    const anchor = box(600, 500, BADGE.w, BADGE.h);
    const others: PlaceBox[] = [
      box(560, 500, BADGE.w, BADGE.h), // 左邻
      box(640, 500, BADGE.w, BADGE.h), // 右邻
      box(400, 560, 400, 40), // 下方一整排徽章（横向排列形态）
    ];
    const p = placeCard(anchor, others, CARD);
    expect(overlaps(p, anchor)).toBe(false);
    expect(p.left).toBeGreaterThanOrEqual(8);
    expect(p.top).toBeGreaterThanOrEqual(8);
    expect(p.left + CARD.w).toBeLessThanOrEqual(1280 - 8);
    expect(p.top + CARD.h).toBeLessThanOrEqual(800 - 8);
  });
});

// v3.9.4：chrome 边界（标题栏/标签栏在上、状态栏在下）——fixed 卡片此前
// 的钳位只认裸视口（8px / vh-160），滚动跟随时可整片盖住标题栏/状态栏。
describe("placeCard chrome 边界（bounds）", () => {
  // 视口 1280×800；chrome：标题栏 36 + 标签栏 34 → bounds.top=78；
  // 状态栏 26 → bounds.bottom=800-26-8=766。
  const BOUNDS = { top: 36 + 34 + 8, bottom: 800 - 26 - 8 };

  it("锚点在视口顶部（y=20 < bounds.top）→ 候选被拒，钳位进 chrome 区间", () => {
    const anchor = box(400, 20, BADGE.w, BADGE.h);
    const p = placeCard(anchor, [], CARD, BOUNDS);
    expect(p.top).toBeGreaterThanOrEqual(BOUNDS.top);
    expect(p.top + CARD.h).toBeLessThanOrEqual(BOUNDS.bottom);
    expect(overlaps(p, anchor)).toBe(false);
  });

  it("锚点贴底（下方候选越界）→ 钳位不进状态栏", () => {
    const anchor = box(400, 720, BADGE.w, BADGE.h);
    const p = placeCard(anchor, [], CARD, BOUNDS);
    expect(p.top + CARD.h).toBeLessThanOrEqual(BOUNDS.bottom);
    expect(overlaps(p, anchor)).toBe(false);
  });

  it("常规中部锚点不受 bounds 影响（候选原样命中）", () => {
    const anchor = box(400, 300, BADGE.w, BADGE.h);
    const p = placeCard(anchor, [], CARD, BOUNDS);
    expect(p.left).toBe(anchor.right + 8);
    expect(p.top).toBe(anchor.top);
  });

  it("bounds 极窄（top > bottom-cardH）→ 仍返回可解释结果（钳到 top 附近）", () => {
    const anchor = box(400, 300, BADGE.w, BADGE.h);
    const p = placeCard(anchor, [], CARD, { top: 700, bottom: 760 });
    expect(p.top).toBeGreaterThanOrEqual(700 - 8);
  });
});

describe("clampTop 滚动跟随钳位", () => {
  const BOUNDS = { top: 78, bottom: 774 };

  it("区间内原样返回", () => {
    expect(clampTop(300, 160, BOUNDS)).toBe(300);
  });

  it("跟出上界（锚点滚到标题栏下）→ 钉在 bounds.top", () => {
    expect(clampTop(-40, 160, BOUNDS)).toBe(78);
  });

  it("跟出下界（锚点滚到状态栏）→ 钉在 bounds.bottom-cardH", () => {
    expect(clampTop(900, 160, BOUNDS)).toBe(774 - 160);
  });

  it("卡片比可用区高 → 退化为 bounds.top（不产生 NaN/负区间）", () => {
    expect(clampTop(300, 800, BOUNDS)).toBe(78);
  });
});
