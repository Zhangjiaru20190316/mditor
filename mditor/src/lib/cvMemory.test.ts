import { afterEach, describe, expect, it } from "vitest";
import {
  CV_STORE_CAP,
  cvClearStore,
  cvHash,
  cvStoreSize,
  cvSizeFor,
  intrinsicStyleOf,
  noteCvSize,
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
