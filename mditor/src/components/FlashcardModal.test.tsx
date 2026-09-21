// @vitest-environment jsdom
// FlashcardModal 组件回归网（锁定 report3 N3 修复）：grade() 评卡后「仅当
// 被评卡原位保留（仍到期且 dueDay 不变）才 setIdx(i+1) 手动前进，否则让
// 到期清单收缩的滑入自然前进」——两机制叠加会每评一张跳过一张。用例
// b/c 分别钉死两个分支，重排用例钉死中间态（仍到期但 dueDay 前移）。
//
// mock 策略（同 FileTree/QuickSwitcher 的 N19 范式：globals 未开显式
// import、RTL v16 显式 afterEach(cleanup)、夹具经 vi.hoisted 供提升的
// vi.mock 工厂引用）：
//   * vaultIndex——importOriginal 保留纯函数导出，单例换成固定索引夹具
//     （2 条目 / 3 张卡，迭代序刻意与 dueDay 序不同以暴露排序），
//     subscribe 恒返回空退订（索引侧无更新需求）；
//   * reviewStore——cardKey 走真实实现（纯函数，键 = `${path}\0${hash}`，
//     夹具哈希只需互异）；单例 get/all/set 为可编程 vi.fn 桩，背后是
//     模块级 Map（reviewBacking）：测试直接 seed dueDay 构造「评后滑出
//     清单 / 原位保留」两种局面。关键：set 必须像真实 store 一样在写入
//     后同步 notify 订阅者——snapshot memo 靠 tick bump 重算，set 不
//     notify 则评后清单永不收缩，N3 滑入机制无从谈起；ensureLoaded /
//     flush 静默 resolve（jsdom 无 Tauri FS）。
//   * flashcards 全真实（纯逻辑）：评档后果（dueDay / box / lapses）用
//     真实 scheduleAfter 数学校验，不靠桩值。
//
// 分支构造（dueDay 均相对 dayOf(Date.now()) 种入）：
//   * 滑出：逾期卡（today−3、box 2）评「良好」→ box 3、间隔 7 天 →
//     dueDay = today+7 → 不再到期，清单收缩滑入原第 2 张（idx 不动）；
//   * 原位保留：恰好今天到期卡（today、box 1）评「忘了」→ 间隔 0 →
//     dueDay 仍为 today（与评前一致）→ 仍到期 → idx 手动 +1。真实调度下
//     这是 staysInPlace 的唯一可达构造——「严重逾期 + 忘了」评后 dueDay
//     会变为 today（≠ 评前值），不满足 nextS.dueDay === prev.dueDay，走
//     的是「重排后移 → 滑入」分支（单独用例钉死）。
//
// 时序：grade() 的全部状态更新（含 set→notify→setTick）同步 batch 于
// fireEvent 的 act 内，断言仍用 findBy* 兜底；EXIT_MS=200 延迟卸载不影响
// 本组用例（open 恒 true，不测卸载时序，关闭仅断言 onClose 回调）。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { FlashcardModal } from "./FlashcardModal";
import { dayOf, isDue, type CardSchedule } from "../lib/flashcards";
import { cardKey } from "../lib/reviewStore";

// 固定索引夹具：algo.md 两张卡 + lang.md 一张卡（迭代序 A1→A2→L1，与按
// dueDay 排序的期望序可通过 seed 任意错开）。哈希只需互异（卡片身份 =
// 路径 + 哈希，组件不复算校验）。reviewBacking/reviewListeners 是测试与
// reviewStore 桩共享的可编程状态面。
const { IDX_ENTRIES, reviewBacking, reviewListeners } = vi.hoisted(() => {
  const mkCard = (
    path: string,
    line: number,
    question: string,
    answer: string,
    hash: string
  ): import("../lib/flashcards").ScannedCard => ({ path, line, question, answer, hash });
  const mkEntry = (
    path: string,
    title: string,
    flashcards: import("../lib/flashcards").ScannedCard[]
  ): import("../lib/vaultIndex").VaultEntry => ({
    path,
    title,
    headings: [],
    links: [],
    tags: [],
    mtime: 1,
    flashcards,
  });
  const IDX_ENTRIES: import("../lib/vaultIndex").VaultEntry[] = [
    mkEntry("notes/algo.md", "算法", [
      mkCard("notes/algo.md", 4, "快排平均时间复杂度？", "O(n log n)", "a1h"),
      mkCard("notes/algo.md", 10, "二分查找的前提？", "有序数组", "a2h"),
    ]),
    mkEntry("notes/lang.md", "语言", [
      mkCard("notes/lang.md", 2, "Java 泛型靠什么实现？", "类型擦除", "l1h"),
    ]),
  ];
  return {
    IDX_ENTRIES,
    reviewBacking: new Map<string, import("../lib/flashcards").CardSchedule>(),
    reviewListeners: new Set<() => void>(),
  };
});

vi.mock("../lib/vaultIndex", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/vaultIndex")>();
  return {
    ...actual,
    vaultIndex: {
      entries: () => IDX_ENTRIES,
      subscribe: () => () => undefined,
    },
  };
});

vi.mock("../lib/reviewStore", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/reviewStore")>();
  return {
    ...actual,
    // cardKey 透传真实实现；单例桩语义对齐真实 ReviewStore——尤其 set 的
    // 同步 notify（snapshot 重算的驱动源），见头注释。
    reviewStore: {
      get: vi.fn((key: string) => reviewBacking.get(key) ?? null),
      all: vi.fn(() => Object.fromEntries(reviewBacking.entries())),
      set: vi.fn((key: string, s: import("../lib/flashcards").CardSchedule) => {
        reviewBacking.set(key, s);
        for (const fn of reviewListeners) fn();
      }),
      subscribe: (fn: () => void) => {
        reviewListeners.add(fn);
        return () => reviewListeners.delete(fn);
      },
      ensureLoaded: vi.fn(() => Promise.resolve()),
      flush: vi.fn(() => Promise.resolve()),
    },
  };
});

// 三张卡的进度键（与 compute() 的 cardKey(entry.path, card.hash) 同构）。
const K_A1 = cardKey("notes/algo.md", "a1h");
const K_A2 = cardKey("notes/algo.md", "a2h");
const K_L1 = cardKey("notes/lang.md", "l1h");

/** 预置进度：默认 box 1 / ease 2.5（评档后间隔可手算），dueDay 必填。 */
function seed(key: string, dueDay: number, over: Partial<CardSchedule> = {}): void {
  reviewBacking.set(key, {
    box: 1,
    ease: 2.5,
    lastReview: 0,
    addedAt: 0,
    reviews: 0,
    lapses: 0,
    dueDay,
    ...over,
  });
}

/** 挂载打开态模态，返回回调 mock 与 RTL 视图。 */
function renderModal(over: { open?: boolean; enabled?: boolean } = {}) {
  const onClose = vi.fn();
  const onOpenNote = vi.fn();
  const view = render(
    <FlashcardModal open={true} enabled={true} onClose={onClose} onOpenNote={onOpenNote} {...over} />
  );
  return { onClose, onOpenNote, view };
}

/** 头部进度条文本（如 "1/2 · 已完成 1"）。 */
const progress = () => document.querySelector(".fc-progress")!.textContent;

/** 点「显示答案」翻面。 */
const flip = () => fireEvent.click(screen.getByText("显示答案（空格）"));

beforeEach(() => {
  vi.clearAllMocks();
  reviewBacking.clear();
  reviewListeners.clear();
});
afterEach(() => {
  cleanup();
});

describe("FlashcardModal（N3 回归：评卡后前进策略）", () => {
  it("打开时按 dueDay 升序渲染最逾期的一张；未入进度的卡按 newSchedule 今天到期", () => {
    const today = dayOf(Date.now());
    seed(K_A2, today - 1);
    seed(K_L1, today - 3, { box: 2 });
    // A1 不在进度 → newSchedule → 今天到期。索引迭代序 A1(今)/A2(昨)/
    // L1(大前天)，排序后 L1 居首——排序真实生效。
    renderModal();
    expect(screen.getByText("Java 泛型靠什么实现？")).toBeInTheDocument();
    expect(screen.queryByText("快排平均时间复杂度？")).not.toBeInTheDocument();
    expect(progress()).toBe("1/3");
    // 来源按钮：文件名:行号（line 2 → 第 3 行）+ 大前天到期 → 逾期标记。
    const link = document.querySelector<HTMLElement>(".fc-note-link")!;
    expect(link.textContent).toContain("来源：lang.md:3");
    expect(link.textContent).toContain("已逾期");
  });

  it("逾期标记时区口径（Q8）：today−2 标「已逾期」，today−1 不标", () => {
    // 种子按 dayOf(Date.now())（本地日序）构造，任何时区/任何运行时刻都
    // 稳定。修复前右式是 UTC epoch 日序，与本地日序相差 0/1 天（UTC+8 下
    // 一天中有 16 小时错位），边界日会错标——本用例钉死两侧边界。
    const today = dayOf(Date.now());
    // 下边界：比「昨天」更早（today−2）→ 标逾期。
    seed(K_A1, today - 2);
    renderModal();
    expect(document.querySelector<HTMLElement>(".fc-note-link")!.textContent).toContain(
      "已逾期"
    );
    cleanup();
    // 上边界：恰好昨天（today−1）→ 不标。
    reviewBacking.clear();
    seed(K_A1, today - 1);
    renderModal();
    const link = document.querySelector<HTMLElement>(".fc-note-link")!;
    expect(link.textContent).toContain("来源：algo.md:5");
    expect(link.textContent).not.toContain("已逾期");
  });

  it("评「良好」→ 卡滑出清单：下一张是原第 2 张，不跳卡（N3 核心）", async () => {
    const today = dayOf(Date.now());
    seed(K_A1, today - 3, { box: 2 }); // 严重逾期，评前排第 1
    seed(K_A2, today); // 原第 2 张
    seed(K_L1, today + 30); // 未到期：不得进清单
    renderModal();
    expect(screen.getByText("快排平均时间复杂度？")).toBeInTheDocument();
    expect(progress()).toBe("1/2");
    flip();
    fireEvent.click(screen.getByText("良好"));
    // A1 → box 3、间隔 7 天 → dueDay today+7：滑出后清单收缩为 [A2]，
    // A2 自然滑入 idx 0——旧回归（idx 无条件 +1）会顶穿清单直接出结束页。
    await screen.findByText("二分查找的前提？");
    expect(screen.queryByText("快排平均时间复杂度？")).not.toBeInTheDocument();
    expect(screen.queryByText("Java 泛型靠什么实现？")).not.toBeInTheDocument();
    expect(screen.queryByText("本轮复习完成 🎉")).not.toBeInTheDocument();
    expect(progress()).toBe("1/1 · 已完成 1");
    // 真实 scheduleAfter 数学校验：间隔表[3]=7 天 × ease 2.5/2.5。
    const s = reviewBacking.get(K_A1)!;
    expect(s.dueDay).toBe(today + 7);
    expect(s.box).toBe(3);
    expect(isDue(s)).toBe(false);
  });

  it("评「忘了」→ 仍当天到期且 dueDay 不变：原位保留分支，idx 前进一位", async () => {
    const today = dayOf(Date.now());
    seed(K_A1, today, { box: 1 }); // 恰好今天到期（非逾期）
    seed(K_A2, today); // 同日第 2 张（稳定排序保持原序）
    seed(K_L1, today + 30);
    renderModal();
    expect(screen.getByText("快排平均时间复杂度？")).toBeInTheDocument();
    // 键盘路径：空格翻面 → 数字 1 评「忘了」。
    fireEvent.keyDown(screen.getByRole("dialog"), { key: " " });
    expect(screen.getByText("忘了")).toBeInTheDocument();
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "1" });
    // scheduleAfter(忘了)：间隔 0 → dueDay 仍 today（与评前一致）且仍
    // 到期 → 手动 idx+1 展示原第 2 张（若 idx 不前进会卡在 A1 重复出题）。
    await screen.findByText("二分查找的前提？");
    expect(progress()).toBe("2/2 · 已完成 1");
    const s = reviewBacking.get(K_A1)!;
    expect(s.dueDay).toBe(today); // dueDay 不变——原位保留的判定条件
    expect(isDue(s)).toBe(true); // 仍到期：A1 留在清单（本轮不再出）
    expect(s.box).toBe(0);
    expect(s.lapses).toBe(1);
  });

  it("严重逾期卡评「忘了」：仍到期但 dueDay 前移 → 重排后移走滑入分支（idx 不动）", async () => {
    const today = dayOf(Date.now());
    seed(K_A1, today - 3, { box: 1 }); // 评前排第 1
    seed(K_A2, today - 1); // 评前排第 2
    seed(K_L1, today + 30);
    renderModal();
    flip();
    fireEvent.click(screen.getByText("忘了"));
    // A1 评后 dueDay 变为 today（≠ 评前 today−3）→ 不满足原位判定 →
    // idx 不动；清单重排为 [A2(−1), A1(today)]，A2 滑入 idx 0——不跳卡。
    await screen.findByText("二分查找的前提？");
    expect(screen.queryByText("快排平均时间复杂度？")).not.toBeInTheDocument();
    expect(progress()).toBe("1/2 · 已完成 1");
    expect(reviewBacking.get(K_A1)!.dueDay).toBe(today);
  });

  it("全部评完 → 结束页（done 统计、总卡数与孤儿提示可见）", async () => {
    const today = dayOf(Date.now());
    seed(K_A1, today - 2);
    seed(K_A2, today - 1);
    seed(K_L1, today + 30); // 未到期但计入「库中共 N 张卡」
    seed(cardKey("notes/gone.md", "gone-h"), today - 9); // 源卡不在索引 → 孤儿
    renderModal();
    flip();
    fireEvent.click(screen.getByText("良好"));
    await screen.findByText("二分查找的前提？");
    flip();
    fireEvent.click(screen.getByText("良好"));
    // 两张全部滑出 → 清清单 → 结束页。
    await screen.findByText("本轮复习完成 🎉");
    expect(progress()).toBe("0/0 · 已完成 2");
    expect(document.querySelector(".fc-sub")!.textContent).toContain("库中共 3 张卡");
    expect(document.querySelector(".fc-warn")!.textContent).toContain(
      "另有 1 张进度卡未找到对应卡片"
    );
  });

  it("关闭按钮与 Esc 都触发 onClose", () => {
    seed(K_A1, dayOf(Date.now()));
    const { onClose } = renderModal();
    fireEvent.click(screen.getByTitle("关闭 (Esc)"));
    expect(onClose).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it("笔记名跳转按钮：onOpenNote 收到（路径, 0-based 行号）", () => {
    seed(K_A1, dayOf(Date.now()));
    const { onOpenNote } = renderModal();
    const link = document.querySelector<HTMLElement>(".fc-note-link")!;
    expect(link.textContent).toContain("来源：algo.md:5");
    fireEvent.click(link);
    expect(onOpenNote).toHaveBeenCalledWith("notes/algo.md", 4);
  });

  it("enabled=false：主体不渲染，只提示开启索引", () => {
    seed(K_A1, dayOf(Date.now()));
    renderModal({ enabled: false });
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(
      screen.getByText("全库索引已关闭——请在「设置 → 知识功能」中开启。")
    ).toBeInTheDocument();
    expect(screen.queryByText("快排平均时间复杂度？")).not.toBeInTheDocument();
    expect(document.querySelector(".fc-card")).toBeNull();
  });

  it("open=false：整组件不挂载", () => {
    const { view } = renderModal({ open: false });
    expect(view.container.childElementCount).toBe(0);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
});
