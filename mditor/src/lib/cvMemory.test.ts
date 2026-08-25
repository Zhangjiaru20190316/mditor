import { afterEach, describe, expect, it } from "vitest";
import {
  CV_STORE_CAP,
  PREWARM_MAX_CHUNK,
  PREWARM_MIN_CHUNK,
  PREWARM_START_CHUNK,
  cvClearStore,
  cvHash,
  cvStoreSize,
  cvSizeFor,
  intrinsicStyleOf,
  nextChunkSize,
  noteCvSize,
  prewarmOrder,
} from "./cvMemory";

afterEach(() => cvClearStore());

describe("cvHash（内容寻址键）", () => {
  it("same content + type → same key; any difference → different key", () => {
    expect(cvHash("heading", "第1章")).toBe(cvHash("heading", "第1章"));
    expect(cvHash("heading", "第1章")).not.toBe(cvHash("paragraph", "第1章"));
    expect(cvHash("heading", "第1章")).not.toBe(cvHash("heading", "第2章"));
  });
});

describe("noteCvSize / cvSizeFor（高度表）", () => {
  it("stores and returns sizes; returns true only for new/changed entries", () => {
    expect(noteCvSize("k1", 800, 112)).toBe(true);
    expect(noteCvSize("k1", 800, 112)).toBe(false); // 完全相同
    expect(noteCvSize("k1", 800, 113)).toBe(false); // ±2px 内视为未变（量测噪声）
    expect(noteCvSize("k1", 800, 120)).toBe(true); // 实质变化
    expect(cvSizeFor("k1")).toEqual({ w: 800, h: 120 });
    expect(cvStoreSize()).toBe(1);
  });

  it("rejects invalid input", () => {
    expect(noteCvSize("", 10, 10)).toBe(false);
    expect(noteCvSize("k", 0, 10)).toBe(false);
    expect(noteCvSize("k", 10, -1)).toBe(false);
    expect(cvStoreSize()).toBe(0);
  });

  it("evicts the oldest half when exceeding the cap", () => {
    for (let i = 0; i < CV_STORE_CAP; i++) noteCvSize(`k${i}`, 100, i);
    expect(cvStoreSize()).toBe(CV_STORE_CAP);
    noteCvSize("fresh", 100, 1); // 触发淘汰
    expect(cvStoreSize()).toBeLessThanOrEqual(CV_STORE_CAP);
    expect(cvSizeFor("fresh")).toBeDefined();
    expect(cvSizeFor("k0")).toBeUndefined(); // 最旧的已被淘汰
    expect(cvSizeFor(`k${CV_STORE_CAP - 1}`)).toBeDefined(); // 较新的保留
  });
});

describe("intrinsicStyleOf（装饰 style）", () => {
  it("emits a two-value contain-intrinsic-size (width + height placeholders)", () => {
    expect(intrinsicStyleOf(812.4, 520.6)).toBe("contain-intrinsic-size: 812px 521px");
    expect(intrinsicStyleOf(0, 0)).toBe("contain-intrinsic-size: 1px 0px");
  });
});

describe("prewarmOrder（P0-1 预热顺序：视口优先、先下后上）", () => {
  it("band asc → doc end → band start-1 back to 0", () => {
    expect(prewarmOrder(10, 4, 7)).toEqual([4, 5, 6, 7, 8, 9, 3, 2, 1, 0]);
  });

  it("clamps out-of-range band", () => {
    // 负起点夹到 0：纯自顶向下（退化 = 旧行为）。
    expect(prewarmOrder(5, -3, 3)).toEqual([0, 1, 2, 3, 4]);
    // 带尾越过文末：向上段仍从带首前一块开始。
    expect(prewarmOrder(5, 3, 99)).toEqual([3, 4, 2, 1, 0]);
    // end < start：夹到空带，起点保持在视口处向上收尾。
    expect(prewarmOrder(4, 3, 1)).toEqual([3, 2, 1, 0]);
  });

  it("empty band degrades to pure top-down (old behavior)", () => {
    expect(prewarmOrder(6, 0, 0)).toEqual([0, 1, 2, 3, 4, 5]);
  });

  it("covers every index exactly once regardless of band", () => {
    for (const [total, s, e] of [
      [100, 37, 42],
      [8088, 0, 0],
      [50, 48, 60],
      [1, 0, 1],
    ] as const) {
      const order = prewarmOrder(total, s, e);
      expect(order).toHaveLength(total);
      expect(new Set(order).size).toBe(total);
      expect(Math.min(...order)).toBe(0);
      expect(Math.max(...order)).toBe(total - 1);
    }
  });
});

describe("nextChunkSize（P0-2 批大小自适应：预算内提效、超预算让出）", () => {
  it("well under half budget → double, capped at MAX", () => {
    expect(nextChunkSize(12, 2, 8)).toBe(24);
    expect(nextChunkSize(50, 1, 8)).toBe(PREWARM_MAX_CHUNK);
  });

  it("over budget → halve, floored at MIN", () => {
    expect(nextChunkSize(100, 30, 8)).toBe(50);
    expect(nextChunkSize(3, 30, 8)).toBe(2);
    expect(nextChunkSize(2, 30, 8)).toBe(1);
    expect(nextChunkSize(1, 30, 8)).toBe(PREWARM_MIN_CHUNK);
  });

  it("middle band (half budget..budget) → keep current size", () => {
    expect(nextChunkSize(24, 5, 8)).toBe(24);
    expect(nextChunkSize(PREWARM_START_CHUNK, 6, 8)).toBe(PREWARM_START_CHUNK);
  });
});
