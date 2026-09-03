// 闪卡调度（SM-2 简化）与文档扫描测试（模块 4）。

import { describe, expect, it } from "vitest";
import {
  cardHash,
  dayOf,
  flashcardMarkdown,
  intervalDays,
  isDue,
  newSchedule,
  scheduleAfter,
  scanFlashcards,
  type CardSchedule,
} from "./flashcards";

describe("SM-2 简化调度", () => {
  it("新卡当天到期、间隔表与 ease 因子", () => {
    const s = newSchedule(0);
    expect(s.box).toBe(0);
    expect(s.ease).toBe(2.5);
    expect(isDue(s, 0)).toBe(true);
    expect(intervalDays(0, 2.5)).toBe(0);
    expect(intervalDays(1, 2.5)).toBe(1);
    expect(intervalDays(5, 2.5)).toBe(30);
    // ease 高 → 间隔更长；ease 低 → 更短。
    expect(intervalDays(5, 3.0)).toBeGreaterThan(30);
    expect(intervalDays(5, 1.5)).toBeLessThan(30);
  });

  it("自评四档推进：忘了归零减 ease；困难减 ease；良好/轻松进盒", () => {
    const t = 1_700_000_000_000;
    let s: CardSchedule = newSchedule(t);
    // 良好 ×2 → box 2。
    s = scheduleAfter(s, 2, t);
    expect(s.box).toBe(1);
    s = scheduleAfter(s, 2, t + 86_400_000);
    expect(s.box).toBe(2);
    expect(s.ease).toBe(2.5);
    expect(s.reviews).toBe(2);
    // 轻松 → box 3、ease 2.65。
    s = scheduleAfter(s, 3, t + 2 * 86_400_000);
    expect(s.box).toBe(3);
    expect(s.ease).toBe(2.65);
    // 困难 → box 不变、ease 2.5。
    s = scheduleAfter(s, 1, t + 3 * 86_400_000);
    expect(s.box).toBe(3);
    expect(s.ease).toBe(2.5);
    // 忘了 → box 0、ease 2.35、当天到期（重学）。
    s = scheduleAfter(s, 0, t + 4 * 86_400_000);
    expect(s.box).toBe(0);
    expect(s.ease).toBe(2.35);
    expect(isDue(s, t + 4 * 86_400_000)).toBe(true);
    expect(s.lapses).toBe(1);
  });

  it("ease 下限 1.3、box 封顶 5", () => {
    const t = 1_700_000_000_000;
    let s = newSchedule(t);
    for (let i = 0; i < 10; i++) s = scheduleAfter(s, 0, t + i * 86_400_000);
    expect(s.ease).toBe(1.3);
    let g = newSchedule(t);
    for (let i = 0; i < 8; i++) g = scheduleAfter(g, 3, t + i * 86_400_000);
    expect(g.box).toBe(5);
    expect(g.ease).toBe(2.5 + 8 * 0.15);
  });

  it("下次到期日 = 当天 + 间隔（良好 3 盒 = 7 天）", () => {
    const t = new Date(2026, 8, 1).getTime();
    let s = newSchedule(t);
    s = scheduleAfter(s, 2, t);
    s = scheduleAfter(s, 2, t + 86_400_000);
    s = scheduleAfter(s, 2, t + 2 * 86_400_000);
    // box 3 → intervalDays = 7。
    expect(s.dueDay - dayOf(t + 2 * 86_400_000)).toBe(7);
    expect(isDue(s, t + 2 * 86_400_000)).toBe(false);
    expect(isDue(s, t + 10 * 86_400_000)).toBe(true);
  });
});

describe("scanFlashcards（行扫描）", () => {
  it("识别 :::flash 容器并按 --- 拆问答", () => {
    const md = ":::flash\n什么是 SM-2？\n---\n间隔重复调度算法。\n:::\n";
    const cards = scanFlashcards(md, "a.md");
    expect(cards.length).toBe(1);
    expect(cards[0]).toMatchObject({
      path: "a.md",
      question: "什么是 SM-2？",
      answer: "间隔重复调度算法。",
      line: 0,
    });
    expect(cards[0].hash).toBe(cardHash("什么是 SM-2？", "间隔重复调度算法。"));
  });

  it("多卡、多行问答拼接、卡后正文继续扫", () => {
    const md = [
      "前置正文。",
      "",
      ":::flash",
      "问题第一行",
      "问题第二行？",
      "---",
      "答案第一行",
      "答案第二行。",
      ":::",
      "",
      "中间正文。",
      "",
      ":::flash",
      "第二张卡？",
      "---",
      "答案二。",
      ":::",
    ].join("\n");
    const cards = scanFlashcards(md);
    expect(cards.length).toBe(2);
    expect(cards[0].question).toBe("问题第一行 问题第二行？");
    expect(cards[0].answer).toBe("答案第一行 答案第二行。");
    expect(cards[1].line).toBe(12);
  });

  it("代码围栏内的 :::flash 不识别；未闭合容器不产出", () => {
    const fenced = "```\n:::flash\nQ\n---\nA\n:::\n```\n";
    expect(scanFlashcards(fenced)).toEqual([]);
    const unclosed = ":::flash\nQ\n---\nA\n（没有闭合）\n";
    expect(scanFlashcards(unclosed)).toEqual([]);
  });

  it("无分隔线的卡：全部文本作为问题", () => {
    const cards = scanFlashcards(":::flash\n只有问题没有分隔线\n:::\n");
    expect(cards.length).toBe(1);
    expect(cards[0].question).toBe("只有问题没有分隔线");
    expect(cards[0].answer).toBe("");
  });
});

describe("flashcardMarkdown", () => {
  it("做卡入口的源文本形态", () => {
    expect(flashcardMarkdown("Q？", "A。")).toBe(":::flash\nQ？\n---\nA。\n:::");
  });
});
