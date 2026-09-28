// 大文档档位判定（lib/memory.ts）：
//  * 减配档 isBigDoc = 总开关 ∧（>500KB ∨ >3000 行）——公式密度绝不触发
//    （那会关掉 KaTeX，对公式密集文档不可接受）。
//  * 视口档 isBigDocCv = 任一开关 ∧（体量 ∨ 公式密度 ≥800 个 `$`）。
// 阈值校准依据生产日志（2026-09-26~28）：6KB/170 公式无异常，
// 35KB/732 公式 1~4.5s 阻塞，104KB/2356 公式掉帧风暴——间隙中段取 800。
import { describe, expect, it, afterEach } from "vitest";
import {
  BIG_DOC_MATH_DOLLARS,
  isBigDoc,
  isBigDocCv,
  setBigDocModeEnabled,
  setBigDocViewportEnabled,
  sizeIsMathDenseDoc,
} from "./memory";

/** 生成恰好 n 个 `$` 的纯文本（无换行堆积——密度与体量两路独立验证）。 */
const dollars = (n: number): string => "a $ x".repeat(n);

afterEach(() => {
  setBigDocModeEnabled(false);
  setBigDocViewportEnabled(false);
});

describe("sizeIsMathDenseDoc（纯密度测试，无设置门）", () => {
  it("达到阈值即真，差一个即假", () => {
    expect(sizeIsMathDenseDoc(dollars(BIG_DOC_MATH_DOLLARS))).toBe(true);
    expect(sizeIsMathDenseDoc(dollars(BIG_DOC_MATH_DOLLARS - 1))).toBe(false);
  });
  it("空/缺省输入为假", () => {
    expect(sizeIsMathDenseDoc(null)).toBe(false);
    expect(sizeIsMathDenseDoc(undefined)).toBe(false);
    expect(sizeIsMathDenseDoc("")).toBe(false);
  });
  it("无公式的长文本为假", () => {
    expect(sizeIsMathDenseDoc("plain text\n".repeat(4000))).toBe(false);
  });
});

describe("isBigDocCv（视口档：体量 ∨ 公式密度，受开关门控）", () => {
  it("开关全关时恒为假（密度再高也不启用）", () => {
    expect(isBigDocCv(dollars(5000))).toBe(false);
  });

  it("视口子开关开启后，密度达标的小文档进入视口档", () => {
    setBigDocViewportEnabled(true);
    // ≈400 公式 ≈4KB 体量，远低于 500KB/3000 行——只有密度路可命中。
    expect(isBigDocCv(dollars(BIG_DOC_MATH_DOLLARS))).toBe(true);
  });

  it("视口子开关开启后，密度不达标的普通文档仍为假", () => {
    setBigDocViewportEnabled(true);
    expect(isBigDocCv("普通笔记，一个公式 $x$ 而已")).toBe(false);
  });

  it("体量路不受密度影响（>500KB 纯文本照常触发）", () => {
    setBigDocViewportEnabled(true);
    expect(isBigDocCv("x".repeat(500_001))).toBe(true);
  });

  it("总开关单开也蕴含视口档（与体量路同语义）", () => {
    setBigDocModeEnabled(true);
    expect(isBigDocCv(dollars(BIG_DOC_MATH_DOLLARS))).toBe(true);
  });
});

describe("isBigDoc（减配档：公式密度绝不触发）", () => {
  it("总开关开启 + 密度极高的小文档仍为假——减配不能靠密度关掉 KaTeX", () => {
    setBigDocModeEnabled(true);
    expect(isBigDoc(dollars(2000))).toBe(false);
  });

  it("总开关开启 + 体量超限照常为真（原语义不变）", () => {
    setBigDocModeEnabled(true);
    expect(isBigDoc("x".repeat(500_001))).toBe(true);
  });

  it("开关关闭时体量再大也为假（原语义不变）", () => {
    expect(isBigDoc("x".repeat(500_001))).toBe(false);
  });
});
